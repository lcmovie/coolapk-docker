import { apiRequest, isTauri } from './runtime';

const values = new Map<string, string>();
let hydrated = false;
let saving = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function allowedKey(key: string): boolean {
  return /^coolapk[._]/.test(key) && key !== 'coolapk_cookie' && !/pending_update/i.test(key);
}

export async function hydrateBrowserStorage(): Promise<void> {
  if (isTauri()) return;
  const stored = await apiRequest<Record<string, unknown>>('/api/store/browser-state.json');
  values.clear();
  for (const [key, value] of Object.entries(stored)) {
    if (allowedKey(key) && typeof value === 'string') values.set(key, value);
  }
  // Credentials from old builds must never be migrated from the browser into state files.
  window.localStorage.removeItem('coolapk_cookie');
  hydrated = true;
}

function scheduleSave(): void {
  if (!hydrated) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushBrowserStorage().catch(() => {
    window.dispatchEvent(new Event('coolapk-storage-error'));
  }); }, 150);
}

export function flushBrowserStorage(onPageHide = false): Promise<void> {
  clearTimeout(saveTimer);
  if (isTauri() || !hydrated) return Promise.resolve();
  const snapshot = Object.fromEntries(values);
  const body = JSON.stringify(snapshot);
  // Fetch keepalive has a shared 64 KiB browser budget. Normal saves may contain
  // large drafts/history; use it only for small final writes when the tab closes.
  const keepalive = onPageHide && new TextEncoder().encode(body).byteLength <= 48 * 1024;
  saving = saving.catch(() => {}).then(async () => {
    await apiRequest('/api/store/browser-state.json', { method: 'PUT', body, keepalive });
  });
  return saving;
}

/** Synchronous state reads after bootstrap hydration, durable writes under /app/data. */
export const stateStorage: Storage = {
  get length() { return isTauri() ? window.localStorage.length : values.size; },
  key(index) { return isTauri() ? window.localStorage.key(index) : [...values.keys()][index] ?? null; },
  getItem(key) { return isTauri() ? window.localStorage.getItem(key) : values.get(key) ?? null; },
  setItem(key, value) {
    if (isTauri()) { window.localStorage.setItem(key, value); return; }
    if (!allowedKey(key)) return;
    values.set(key, String(value));
    scheduleSave();
  },
  removeItem(key) {
    if (isTauri()) { window.localStorage.removeItem(key); return; }
    if (values.delete(key)) scheduleSave();
  },
  clear() {
    if (isTauri()) { window.localStorage.clear(); return; }
    values.clear();
    scheduleSave();
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { void flushBrowserStorage(true).catch(() => {}); });
}
