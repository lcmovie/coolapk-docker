import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProjectCommunityStats } from '../projectCommunity';

afterEach(() => vi.unstubAllGlobals());

describe('Docker project community', () => {
  it('uses this repository without credentials and preserves real zero counts', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 0, forks_count: 2, open_issues_count: 1 }) });
    vi.stubGlobal('fetch', request);
    expect(await fetchProjectCommunityStats()).toEqual({ stars: 0, forks: 2, issues: 1 });
    expect(request).toHaveBeenCalledWith('https://api.github.com/repos/lcmovie/coolapk-docker', expect.objectContaining({ credentials: 'omit' }));
  });

  it.each([undefined, -1, NaN, '0', 1.5])('rejects invalid count %s rather than presenting zero', async (value) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: value, forks_count: 0, open_issues_count: 0 }) }));
    await expect(fetchProjectCommunityStats()).rejects.toThrow('数据格式错误');
  });

  it('propagates abort and API errors to the visible unknown state', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    vi.stubGlobal('fetch', request);
    await expect(fetchProjectCommunityStats(controller.signal)).rejects.toThrow('HTTP 429');
    expect(request.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
