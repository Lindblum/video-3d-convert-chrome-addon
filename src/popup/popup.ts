import type { PopupRequest, PopupStatus } from '../shared/protocol';
import { loadSettings, NEUTRAL_CLEANUP, saveSettings, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const toggleBtn = $<HTMLButtonElement>('toggle');

const FORMAT: Partial<Record<keyof Settings, (v: number) => string>> = {
  strength: (v) => `${v.toFixed(1)}%`,
  convergence: (v) => v.toFixed(2),
  smoothing: (v) => v.toFixed(2),
  edgeDilation: (v) => (v ? `${v} px` : 'off'),
  edgeSnap: (v) => (v ? v.toFixed(2) : 'off'),
};

/** The tab's answer; 'no-access' when the user hasn't allowed the extension on its page. */
type TabStatus = PopupStatus | 'no-access' | null;

async function send(msg: PopupRequest): Promise<TabStatus> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return null;
  const ask = async () => {
    try {
      return ((await chrome.tabs.sendMessage(tab.id!, msg)) as PopupStatus | undefined) ?? null;
    } catch {
      return null; // no content script, or no frame with a video
    }
  };
  const status = await ask();
  if (status) return status;
  // The tab's content script may be left over from before the extension was reloaded (the
  // browser can do that on its own, e.g. after sleep): still running, but unreachable. A fresh
  // copy takes over from it (see TAKEOVER in content/index.ts). It skips itself where a
  // working copy is already loaded.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
  } catch (e) {
    // Site access set to "on click" or to other sites only; otherwise a page extensions can't
    // touch at all (chrome://, the web store).
    return /permission/i.test(String(e)) ? 'no-access' : null;
  }
  return ask();
}

async function showStatus(t: TabStatus) {
  const s = t === 'no-access' ? null : t;
  const on = !!s && s.active > 0;
  toggleBtn.disabled = !s;
  toggleBtn.textContent = on ? 'On' : 'Off';
  toggleBtn.classList.toggle('on', on);
  document.body.classList.toggle('off', !on);
  statusEl.classList.toggle('warn', !!s && s.buildId !== __BUILD_ID__);
  if (t === 'no-access') {
    // The browser hides the address of a page we can't access, so it may be a local file too.
    const files = (await chrome.extension.isAllowedFileSchemeAccess()) ? '' : ' (or Allow access to file URLs, for a local file)';
    statusEl.textContent = `2D-3D can't read this page. Allow it under Site access${files} in the extension's `;
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'details';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    });
    statusEl.append(link, '.');
  } else if (!s) statusEl.textContent = 'No video found on this page. (Just reloaded the extension? Refresh this tab.)';
  else if (s.buildId !== __BUILD_ID__) statusEl.textContent = 'This tab is running an older version. Reload the extension, then refresh this tab.';
  else if (s.active) statusEl.textContent = `3D · ${s.mode}`;
  else statusEl.textContent = `${s.videos} video${s.videos > 1 ? 's' : ''} found · ${s.error ? `Couldn't start: ${s.error}` : '2D'}`;
}

// Option sections remember whether they were left open or closed.
const SECTIONS_KEY = 'popupSections';
const sectionState = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}') as Record<string, boolean>;
for (const d of document.querySelectorAll<HTMLDetailsElement>('details.section')) {
  const name = d.dataset.section!;
  if (name in sectionState) d.open = sectionState[name];
  d.addEventListener('toggle', () => {
    sectionState[name] = d.open;
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(sectionState));
  });
}

// The Artifact Cleanup checkbox enables or greys out everything in its section.
const cleanup = document.getElementById('cleanup') as HTMLInputElement;
function syncCleanupSection() {
  (document.getElementById('cleanupOptions') as HTMLFieldSetElement).disabled = !cleanup.checked;
}
cleanup.addEventListener('input', syncCleanupSection);

type Control = HTMLInputElement | HTMLSelectElement;

function control(key: keyof Settings): Control | null {
  return document.getElementById(key) as Control | null;
}

function renderOutput(key: keyof Settings, el: Control) {
  const out = document.querySelector<HTMLOutputElement>(`output[for="${key}"]`);
  if (out && FORMAT[key]) out.textContent = FORMAT[key]!(Number(el.value));
}

/** Shows these settings in the popup's controls. */
function fill(settings: Partial<Settings>) {
  for (const [key, value] of Object.entries(settings) as [keyof Settings, unknown][]) {
    const el = control(key);
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value as boolean;
    else el.value = String(value);
    renderOutput(key, el);
  }
  syncCleanupSection();
}

async function init() {
  const settings = await loadSettings();
  fill(settings);
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    const el = control(key);
    if (!el) continue;
    const isNumber = typeof settings[key] === 'number';
    el.addEventListener('input', () => {
      renderOutput(key, el);
      let v: Settings[typeof key];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') v = el.checked;
      else if (isNumber) v = Number(el.value);
      else v = el.value as Settings[typeof key];
      saveSettings({ [key]: v });
    });
  }

  $('resetCleanup').addEventListener('click', () => {
    saveSettings(NEUTRAL_CLEANUP);
    fill(NEUTRAL_CLEANUP);
  });

  toggleBtn.addEventListener('click', async () => showStatus(await send({ type: 'toggle' })));
  showStatus(await send({ type: 'status' }));
}

init();
