// Content script entry: finds videos, wires the hover button, keyboard shortcuts and popup
// messages, and manages one Session per converted video.
import { depthBridge } from '../depth/bridge';
import { TaintedVideoError, taintedVideoMessage, taintedVideoReason } from '../render/renderer';
import type { PopupRequest, PopupStatus } from '../shared/protocol';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type Layout, type Settings } from '../shared/settings';
import { Session } from './session';
import { Overlay, type ButtonState } from './ui';

/**
 * Dispatched on the document by each copy of this script as it starts. When the extension is
 * reloaded or updated (which the browser may do on its own, e.g. after sleep), the copy
 * already in the page keeps drawing 3D but can no longer reach the extension, so the popup
 * can't control it. The popup then injects a fresh copy, and this event tells the stranded
 * one to hand over: it stops, marking its videos (RESUME_KEY) for the new copy to restart.
 */
const TAKEOVER = 'sbs3d:takeover';
const RESUME_KEY = 'sbs3dResume';

const MIN_W = 200;
const MIN_H = 112;

/** View modes in popup order, which Alt+Shift+M cycles through. */
const LAYOUTS: [Layout, string][] = [
  ['hsbs', 'SBS'],
  ['htab', 'TOB'],
  ['anaglyph', 'Anaglyph'],
  ['depth', 'Depth Map'],
  ['rgbd', 'Video | Depth Map'],
];

declare global {
  interface Window {
    __sbs3dLoaded?: boolean;
  }
}

if (!window.__sbs3dLoaded) {
  window.__sbs3dLoaded = true;
  main();
}

function main() {
  document.dispatchEvent(new Event(TAKEOVER));
  let settings: Settings = DEFAULT_SETTINGS;
  const sessions = new Map<HTMLVideoElement, Session>();
  let overlay: Overlay | null = null;
  let hovered: HTMLVideoElement | null = null;
  const listening = new AbortController();
  const signal = listening.signal;

  loadSettings().then((s) => {
    settings = s;
    sessions.forEach((sess) => sess.applySettings(s)); // resumed before the settings were in
  });
  onSettingsChanged((s) => {
    settings = s;
    sessions.forEach((sess) => sess.applySettings(s));
  });

  const ui = () => (overlay ??= new Overlay(toggle));
  // Heuristic depth runs meanwhile; the model is cached after this first download.
  depthBridge.onProgress = (f) => {
    const pct = Math.round(f * 100);
    ui().toast(pct < 100 ? `Downloading depth model (first use only)… ${pct}%` : 'Depth model downloaded', 3000);
  };

  function candidates(): HTMLVideoElement[] {
    return [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= MIN_W && r.height >= MIN_H;
    });
  }

  /** The video a shortcut or popup click should act on. */
  function primary(): HTMLVideoElement | null {
    if (hovered?.isConnected) return hovered;
    const area = (v: HTMLVideoElement) => {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return w * h * (v.paused ? 1 : 2);
    };
    return candidates().sort((a, b) => area(b) - area(a))[0] ?? null;
  }

  /** Why 3D last failed to start or stopped on its own (shown in the popup). */
  let lastError = '';
  /** Videos whose pixels the browser won't let us read, with what they were playing then. */
  const unreadable = new WeakMap<HTMLVideoElement, string>();
  const isUnreadable = (v: HTMLVideoElement) => !!v.mediaKeys || unreadable.get(v) === v.currentSrc;
  const buttonState = (v: HTMLVideoElement): ButtonState =>
    sessions.has(v) ? 'on' : isUnreadable(v) ? 'unavailable' : 'off';

  function toggle(video: HTMLVideoElement): boolean {
    const existing = sessions.get(video);
    if (existing) {
      existing.stop();
      ui().toast('2D', 1500);
      return false;
    }
    let session: Session | null = null;
    try {
      session = new Session(video, settings, ui(), (s) => {
        sessions.delete(s.video);
        if (s.unreadable) {
          unreadable.set(s.video, s.video.currentSrc);
          lastError = taintedVideoReason(s.video);
        }
        overlay?.setButtonState(s.video, buttonState(s.video));
      });
      session.start();
    } catch (e) {
      session?.stop();
      if (e instanceof TaintedVideoError) {
        unreadable.set(video, video.currentSrc);
        lastError = taintedVideoReason(video);
        ui().toast(taintedVideoMessage(video), 7000);
      } else {
        lastError = e instanceof Error ? e.message : String(e);
        ui().toast(`3D failed to start: ${lastError}`, 7000);
        console.error('[2D-3D]', e);
      }
      overlay?.setButtonState(video, buttonState(video));
      return false;
    }
    lastError = '';
    sessions.set(video, session);
    overlay?.setButtonState(video, 'on');
    ui().toast(`3D · ${session.modeLabel}`, 3000);
    return true;
  }

  // Hover button: hit-test videos on mouse move (once per animation frame).
  let moveQueued = false;
  let lastPoint = { x: 0, y: 0 };
  document.addEventListener(
    'mousemove',
    (e) => {
      lastPoint = { x: e.clientX, y: e.clientY };
      if (moveQueued) return;
      moveQueued = true;
      requestAnimationFrame(() => {
        moveQueued = false;
        const { x, y } = lastPoint;
        hovered = candidates().find((v) => {
          const r = v.getBoundingClientRect();
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        }) ?? null;
        if (hovered) ui().showButton(hovered, buttonState(hovered));
      });
    },
    { passive: true, signal },
  );

  // Alt+Shift+D toggles 3D on the hovered (or largest) video; Alt+Shift+M switches to the
  // next view mode. Handled in-page so they work inside the site's own fullscreen too.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== 'KeyD' && e.code !== 'KeyM') return;
      const video = primary();
      if (!video) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'KeyD') {
        toggle(video);
      } else {
        const i = LAYOUTS.findIndex(([layout]) => layout === settings.layout);
        const [layout, name] = LAYOUTS[(i + 1) % LAYOUTS.length];
        settings = { ...settings, layout };
        saveSettings({ layout });
        ui().toast(`View mode: ${name}`, 2000);
      }
    },
    { capture: true, signal },
  );

  const onMessage = (msg: PopupRequest, _sender: chrome.runtime.MessageSender, respond: (s: PopupStatus) => void) => {
    // Only frames that actually contain a video answer, so the popup hears from the right one.
    const videos = candidates();
    if (!videos.length) return false;
    if (msg.type === 'toggle') {
      const v = primary();
      if (v) toggle(v);
    }
    const first = sessions.values().next().value;
    respond({ videos: videos.length, active: sessions.size, mode: first?.modeLabel ?? '', error: lastError || undefined, buildId: __BUILD_ID__ });
    return false;
  };
  chrome.runtime.onMessage.addListener(onMessage);

  document.addEventListener(
    TAKEOVER,
    () => {
      listening.abort();
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {} // the extension context is already gone
      for (const [video, session] of sessions) {
        video.dataset[RESUME_KEY] = '';
        session.stop();
      }
      overlay?.dispose();
      depthBridge.dispose();
      window.__sbs3dLoaded = false;
    },
    { signal },
  );

  // Restart 3D on videos a stranded copy handed over, at once so the popup sees it on.
  for (const v of document.querySelectorAll('video')) {
    if (!(RESUME_KEY in v.dataset)) continue;
    delete v.dataset[RESUME_KEY];
    toggle(v);
  }
}
