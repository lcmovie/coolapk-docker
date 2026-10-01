import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../../utils/runtime');
const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled, invoke: native.invoke }));
vi.mock('../../router', () => ({ router: { push: vi.fn(), resolve: vi.fn(() => ({ matched: [] })) } }));
import { CoolapkTauriAPI } from '../coolapk';
import { listen } from '../../utils/runtime';

const token = 'a'.repeat(64);
const stagedPath = `upload:${token}`;
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });

describe('browser binary uploads and durable attachment references', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    native.enabled = false;
    native.invoke.mockReset();
    fetchMock = vi.fn(async () => ok({ code: 200, data: 'https://image.coolapk.com/synthetic.png' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('a CDN upload takes longer than 90 seconds without an implicit deadline or retry', async () => {
    fetchMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ok({ code: 200, data: 'https://image.coolapk.com/synthetic.png' })), 120_000)));
    const pending = CoolapkTauriAPI.uploadFileToCdn('synthetic-task', stagedPath, 1);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    await expect(pending).resolves.toEqual({ code: 200, data: 'https://image.coolapk.com/synthetic.png' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failed CDN upload sends one request and marks its outcome uncertain', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await expect(CoolapkTauriAPI.uploadFileToCdn('synthetic-task', stagedPath, 1)).rejects.toThrow('结果未知');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stages the original File body and encoded filename without JSON expansion', async () => {
    const file = new File(['synthetic'], '合成 文件.txt', { type: 'text/plain' });
    fetchMock.mockResolvedValue(ok({ filePath: stagedPath, fileName: file.name, size: file.size }));
    await expect(CoolapkTauriAPI.stageCdnFile(file)).resolves.toEqual({ filePath: stagedPath, fileName: file.name, size: file.size });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/uploads/stage?name=${encodeURIComponent(file.name)}`, expect.objectContaining({ body: file, method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } }));
  });

  it('draft attachments use a distinct durable purpose and authenticated Blob reads', async () => {
    const file = new File(['synthetic'], 'draft.txt');
    fetchMock.mockResolvedValueOnce(ok({ filePath: stagedPath, fileName: file.name, size: file.size }));
    await CoolapkTauriAPI.stageDraftFile(file);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/uploads/stage?purpose=draft&name=draft.txt');
    const blob = new Blob(['synthetic']);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, blob: async () => blob });
    await expect(CoolapkTauriAPI.readStagedFile(stagedPath)).resolves.toBe(blob);
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/uploads/stage/${token}`, { credentials: 'same-origin' });
    fetchMock.mockResolvedValueOnce(ok({ released: true }));
    await CoolapkTauriAPI.releaseCdnFile(stagedPath);
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/uploads/stage/${token}`, expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }));
  });

  it('rejects server paths and over-limit files before network access', async () => {
    await expect(CoolapkTauriAPI.releaseCdnFile('/app/data/accounts/accounts.json')).rejects.toThrow('标识无效');
    await expect(CoolapkTauriAPI.readStagedFile('upload:../accounts')).rejects.toThrow('标识无效');
    const file = new File(['x'], 'too-large.bin');
    Object.defineProperty(file, 'size', { value: 256 * 1024 * 1024 + 1 });
    await expect(CoolapkTauriAPI.stageCdnFile(file)).rejects.toThrow('256 MB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an already cancelled local stage does not start transport', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(CoolapkTauriAPI.stageCdnFile(new File(['x'], 'fixture.txt'), controller.signal)).rejects.toThrow('结果未知');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('video and cover use multipart bytes and leave boundary selection to the browser', async () => {
    await CoolapkTauriAPI.uploadPublishVideo(new Uint8Array(12), 'fixture.mp4', new Uint8Array([255, 216, 255]), 2);
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/uploads/publish-video');
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('video').name).toBe('fixture.mp4');
    expect(options.body.get('video').size).toBe(12);
    expect(options.body.get('cover').size).toBe(3);
    expect(options.body.get('duration')).toBe('2');
    expect(options.headers).not.toHaveProperty('Content-Type');
  });

  it.each([null, {}, 'not-json'])('a malformed multipart success %s is uncertain and never resubmitted', async (response) => {
    fetchMock.mockResolvedValue(ok(response));
    await expect(CoolapkTauriAPI.uploadPublishVideo(new Uint8Array(12), 'fixture.mp4', new Uint8Array([255, 216, 255]), 2)).rejects.toThrow('结果未知');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a malformed stage result cannot be committed as a server-path draft reference', async () => {
    fetchMock.mockResolvedValue(ok({ filePath: '/app/data/accounts/accounts.json', fileName: 'fixture.txt', size: 1 }));
    await expect(CoolapkTauriAPI.stageDraftFile(new File(['x'], 'fixture.txt'))).rejects.toThrow('结果未知');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('live photos use multipart image and video parts with publish options', async () => {
    await CoolapkTauriAPI.uploadImage(new Uint8Array([1, 2, 3]), 'fixture.png', 'image/png', 'feed', '12345', new Uint8Array(12), 1);
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/uploads/image');
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('image').size).toBe(3);
    expect(options.body.get('liveVideo').size).toBe(12);
    expect(options.body.get('toUid')).toBe('12345');
    expect(options.body.get('hdr')).toBe('1');
    expect(options.body.get('dir')).toBe('feed');
  });

  it('desktop uploads preserve the upstream command and argument contract', async () => {
    native.enabled = true;
    native.invoke.mockResolvedValue({ code: 200, data: 'synthetic' });
    const bytes = new Uint8Array(12);
    await CoolapkTauriAPI.uploadPublishVideo(bytes, 'fixture.mp4', bytes, 2);
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('upload_publish_video', { videoBytes: bytes, fileName: 'fixture.mp4', coverBytes: bytes, duration: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CDN cancellation remains a boolean command response', async () => {
    fetchMock.mockResolvedValue(ok(true));
    await expect(CoolapkTauriAPI.cancelCdnUpload('synthetic-task')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/invoke/cancel_cdn_upload', expect.objectContaining({ body: '{"taskId":"synthetic-task"}' }));
  });

  it('forwards CDN named progress events through the actual runtime listener', async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const close = vi.fn();
    vi.stubGlobal('EventSource', class { constructor(public url: string) {} addEventListener(name: string, handler: (event: MessageEvent) => void) { listeners.set(name, handler); } close = close; });
    const handler = vi.fn();
    const unsubscribe = await listen('cdn-upload-progress', handler);
    const payload = { taskId: 'synthetic-task', attempt: 2, uploaded: 4, total: 8, status: 'uploading' };
    listeners.get('cdn-upload-progress')!(new MessageEvent('cdn-upload-progress', { data: JSON.stringify(payload) }));
    expect(handler).toHaveBeenCalledExactlyOnceWith({ event: 'cdn-upload-progress', id: 0, payload });
    unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
