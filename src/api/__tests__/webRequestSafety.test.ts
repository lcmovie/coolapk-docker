import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../../utils/runtime');
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled, invoke: native.invoke }));

import { CoolapkTauriAPI } from '../coolapk';
import { apiRequest, invoke } from '../../utils/runtime';

function ok(data: unknown = { id: 'synthetic-feed' }) {
  return { ok: true, status: 200, json: async () => ({ code: 200, data }) };
}

describe('web request deadlines and mutation safety', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    native.enabled = false;
    native.invoke.mockReset();
    fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a web post succeeding after 20 seconds is sent once and retains its result', async () => {
    fetchMock.mockImplementation(() => new Promise((resolve) => window.setTimeout(() => resolve(ok()), 20_000)));
    const pending = CoolapkTauriAPI.createFeed('synthetic test content');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({ code: 200, data: { id: 'synthetic-feed' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['post', () => CoolapkTauriAPI.createFeed('synthetic')],
    ['reply', () => CoolapkTauriAPI.replyFeed('synthetic-feed', 'synthetic')],
    ['private message', () => CoolapkTauriAPI.sendPrivateMessage('12345', 'synthetic')],
    ['private image', () => CoolapkTauriAPI.sendPrivateImage('12345', 'synthetic-image')],
    ['like', () => CoolapkTauriAPI.likeFeed('synthetic-feed')],
    ['delete', () => CoolapkTauriAPI.deleteFeed('synthetic-feed')],
    ['reset configuration', () => CoolapkTauriAPI.getHomeTabConfig(true)],
  ])('a %s receiving HTTP 503 never retries', async (_label, action) => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'HTTP 503' }) });
    await expect(action()).rejects.toThrow('结果未知，请先确认是否已完成');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a post with an unknown success response never retries and asks for confirmation', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(CoolapkTauriAPI.createFeed('synthetic')).rejects.toThrow('结果未知，请先确认是否已完成');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['upstream transport', 400, 'error sending request for url (https://api.coolapk.com/v6/feed/createFeed)'],
    ['upstream response body', 400, 'failed to read Coolapk response: error decoding response body'],
    ['upstream JSON', 400, 'invalid Coolapk JSON response: expected value at line 1 column 1'],
    ['upstream HTTP 500', 400, 'Coolapk API returned HTTP 500 Internal Server Error: empty response body'],
    ['service HTTP 500', 500, undefined],
  ])('a post with %s failure reports an unknown result without resubmitting', async (_label, status, error) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({ error }) });
    await expect(CoolapkTauriAPI.createFeed('synthetic')).rejects.toThrow('结果未知，请先确认是否已完成');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('upstream JSON parsing errors do not enable automatic retries for reads', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'invalid Coolapk JSON response: expected value at line 1 column 1' }) });
    await expect(CoolapkTauriAPI.getDiscoveryConfig()).rejects.toThrow('invalid Coolapk JSON response');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a web write deadline aborts browser transport without another submission', async () => {
    // Ignore cancellation deliberately: an upstream write may already be in progress.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = CoolapkTauriAPI.createFeed('synthetic');
    const rejected = expect(pending).rejects.toThrow('结果未知，请先确认是否已完成');
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a rejected safe read retries sequentially after the original attempt settles', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'HTTP 503' }) }).mockResolvedValueOnce(ok([]));
    const pending = CoolapkTauriAPI.getDiscoveryConfig();
    await vi.advanceTimersByTimeAsync(349);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ code: 200, data: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a caller AbortSignal propagates through invoke to the HTTP fetch', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = invoke('get_discovery_config', {}, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    controller.abort();
    await rejected;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('direct HTTP invokes also enforce a deadline and remove their timer', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = invoke('create_feed', {}, { timeoutMs: 500 });
    const rejected = expect(pending).rejects.toThrow('结果未知，请先确认是否已完成');
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the native 15-second deadline and native invoke arguments', async () => {
    native.enabled = true;
    native.invoke.mockImplementation(() => new Promise(() => {}));
    const pending = CoolapkTauriAPI.createFeed('synthetic');
    const rejected = expect(pending).rejects.toThrow('结果未知，请先确认是否已完成');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('create_feed', { message: 'synthetic' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('long APK streams retain their separate pause/cancel workflow', async () => {
    fetchMock.mockImplementation(() => new Promise((resolve) => window.setTimeout(() => resolve(ok()), 120_000)));
    const pending = invoke('start_apk_download', { taskId: 'synthetic-download' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toEqual({ code: 200, data: { id: 'synthetic-feed' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('store requests and UI links keep their existing behavior', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await invoke('open_url', { url: 'https://www.coolapk.com/feed/123' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const controller = new AbortController();
    await apiRequest('/api/store/web-smoke.json', { signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    open.mockRestore();
  });
});
