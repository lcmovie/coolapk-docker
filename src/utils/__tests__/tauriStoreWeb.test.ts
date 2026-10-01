import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('../runtime', () => ({ apiRequest: mocks.apiRequest }));

describe('WebStore提交快照和串行写入', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

  it('PUT失败后读取仍返回已提交值，不缓存未确认变更', async () => {
    mocks.apiRequest.mockResolvedValueOnce({ value: 'old' }).mockRejectedValueOnce(new Error('network unavailable'));
    const store = await import('../tauriStore');
    await expect(store.writeTauriStoreValue('rollback.json', 'value', 'dirty')).rejects.toThrow('network unavailable');
    expect(await store.readTauriStoreValue('rollback.json', 'value')).toBe('old');
    expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
  });

  it('失败写不会覆盖排队的另一字段写，后续提交使用旧快照', async () => {
    let rejectFirst!: (error: Error) => void;
    mocks.apiRequest.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (!options) return { original: 'kept' };
      if (String(options.body).includes('dirty')) return new Promise((_resolve, reject) => { rejectFirst = reject; });
      return {};
    });
    const store = await import('../tauriStore');
    const failed = expect(store.writeTauriStoreValue('queue.json', 'first', 'dirty')).rejects.toThrow('uncertain');
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf('function'));
    const second = store.writeTauriStoreValue('queue.json', 'second', 'committed');
    expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
    rejectFirst(new Error('uncertain'));
    await failed; await second;
    expect(await store.readTauriStoreValue('queue.json', 'first')).toBeUndefined();
    expect(await store.readTauriStoreValue('queue.json', 'original')).toBe('kept');
    expect(await store.readTauriStoreValue('queue.json', 'second')).toBe('committed');
    const lastBody = JSON.parse(String(mocks.apiRequest.mock.calls.at(-1)?.[1]?.body));
    expect(lastBody).toEqual({ original: 'kept', second: 'committed' });
  });
});
