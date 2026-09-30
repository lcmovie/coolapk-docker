import { beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.innerHTML = '';
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  isTauri: vi.fn(() => true),
}));

// Existing component tests exercise the desktop adapter. The web tests explicitly
// unmock this module and verify the actual HTTP transport and durable state.
vi.mock('./utils/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/runtime')>();
  const core = await import('@tauri-apps/api/core');
  const events = await import('@tauri-apps/api/event');
  return {
    ...actual,
    invoke: core.invoke,
    listen: events.listen,
    isTauri: () => {
      try { return typeof core.isTauri === 'function' ? core.isTauri() : true; }
      catch { return true; }
    },
    apiRequest: vi.fn(async () => ({})),
  };
});
vi.mock('./utils/persistentStorage', () => ({
  stateStorage: localStorage,
  hydrateBrowserStorage: vi.fn(async () => {}),
  flushBrowserStorage: vi.fn(async () => {}),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
