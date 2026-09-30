import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../runtime');
vi.unmock('../persistentStorage');
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled, invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { apiRequest, invoke, mediaProxyUrl } from '../runtime';
import { flushBrowserStorage, hydrateBrowserStorage, stateStorage } from '../persistentStorage';

describe('web runtime and NAS persistence', () => {
  let server: Record<string, string>;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    native.enabled = false;
    server = {};
    native.invoke.mockReset();
    fetchMock = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === 'PUT') server = JSON.parse(String(options.body));
      return { ok: true, status: 200, json: async () => structuredClone(server) };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('uses same-origin HTTP in browser and preserves original native commands on desktop', async () => {
    await invoke('search', { query: '手机', page: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/invoke/search', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ query: '手机', page: 1 }),
    }));
    native.enabled = true;
    native.invoke.mockResolvedValue({ code: 200, data: [] });
    expect(await invoke('get_feed', { page: 1 })).toEqual({ code: 200, data: [] });
    expect(native.invoke).toHaveBeenCalledWith('get_feed', { page: 1 });
    native.enabled = false;
  });

  it('reports wrong access password inline without expiring the loaded app', async () => {
    const expired = vi.fn();
    window.addEventListener('coolapk-access-expired', expired);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: '密码错误' }) });
    await expect(apiRequest('/api/auth/login', { method: 'POST', body: '{}' })).rejects.toThrow('密码错误');
    expect(expired).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'expired' }) });
    await expect(apiRequest('/api/store/settings.json')).rejects.toThrow('访问会话已过期');
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener('coolapk-access-expired', expired);
  });

  it('hydrates from the installation directory, persists changes and restores after a new browser session', async () => {
    server.coolapk_messages_sidebar_width = '312';
    await hydrateBrowserStorage();
    expect(stateStorage.getItem('coolapk_messages_sidebar_width')).toBe('312');
    stateStorage.setItem('coolapk.digital.display_mode', 'list');
    stateStorage.removeItem('coolapk_messages_sidebar_width');
    await flushBrowserStorage();
    expect(server).toEqual({ 'coolapk.digital.display_mode': 'list' });
    expect(localStorage.getItem('coolapk.digital.display_mode')).toBeNull();
    await hydrateBrowserStorage();
    expect(stateStorage.getItem('coolapk.digital.display_mode')).toBe('list');
  });

  it('does not import, return, or persist legacy Cookie data', async () => {
    localStorage.setItem('coolapk_cookie', 'private-test-value');
    server.coolapk_cookie = 'private-test-value';
    server.other_application_key = 'irrelevant';
    await hydrateBrowserStorage();
    expect(localStorage.getItem('coolapk_cookie')).toBeNull();
    expect(stateStorage.getItem('coolapk_cookie')).toBeNull();
    stateStorage.setItem('coolapk_cookie', 'must-not-persist');
    stateStorage.setItem('coolapk_pending_update', 'not-for-web');
    stateStorage.setItem('coolapk_recent_emojis', '["doge"]');
    await flushBrowserStorage();
    expect(server).toEqual({ coolapk_recent_emojis: '["doge"]' });
  });

  it('fails hydration when durable storage is unavailable instead of falling back to transient state', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: '磁盘不可用' }) });
    await expect(hydrateBrowserStorage()).rejects.toThrow('磁盘不可用');
  });

  it('proxies remote videos and rejects executable external link protocols', async () => {
    expect(mediaProxyUrl('https://video.weibocdn.com/example.mp4')).toBe('/api/media?url=https%3A%2F%2Fvideo.weibocdn.com%2Fexample.mp4');
    await expect(invoke('open_url', { url: 'javascript:alert(1)' })).rejects.toThrow('不支持的链接协议');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes native image byte arrays as JSON arrays for the Rust HTTP API', async () => {
    await invoke('upload_image', { imageBytes: new Uint8Array([137, 80, 78, 71]), extension: 'png' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ imageBytes: [137, 80, 78, 71], extension: 'png' });
  });

  it('persists large draft state without the browser keepalive body-size limit', async () => {
    await hydrateBrowserStorage();
    stateStorage.setItem('coolapk_drafts', 'x'.repeat(100_000));
    await flushBrowserStorage();
    expect(server.coolapk_drafts).toHaveLength(100_000);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/store/browser-state.json', expect.objectContaining({ keepalive: false }));
    await flushBrowserStorage(true);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/store/browser-state.json', expect.objectContaining({ keepalive: false }));
  });
});
