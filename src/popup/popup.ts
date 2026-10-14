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

async function send(msg: PopupRequest): Promise<PopupStatus | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return null;
  try {
    return (await chrome.tabs.sendMessage(tab.id, msg)) ?? null;
  } catch {
    return null; // no content script (chrome:// page, store) or no frame with a video
  }
}

function showStatus(s: PopupStatus | null) {
  const on = !!s && s.active > 0;
  toggleBtn.disabled = !s;
  toggleBtn.textContent = on ? 'On' : 'Off';
  toggleBtn.classList.toggle('on', on);
  statusEl.classList.toggle('warn', !!s && s.buildId !== __BUILD_ID__);
  if (!s) statusEl.textContent = 'No video found on this page. (Just reloaded the extension? Refresh this tab.)';
  else if (s.buildId !== __BUILD_ID__) statusEl.textContent = 'This tab is running an older version. Reload the extension, then refresh this tab.';
  else if (s.active) statusEl.textContent = `3D · ${s.mode}`;
  else statusEl.textContent = `${s.videos} video${s.videos > 1 ? 's' : ''} found · 2D`;
}

// The Artifact cleanup checkbox enables or greys out everything in its section.
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
