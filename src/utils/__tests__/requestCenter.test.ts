import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReadOnlyCommand, requestWithPolicy, shouldRetryRequest } from '../requestCenter';

afterEach(() => { vi.useRealTimers(); });

describe('requestCenter', () => {
  it('只对可恢复的网络错误进行重试', () => {
    expect(shouldRetryRequest(new Error('请求超时'))).toBe(true);
    expect(shouldRetryRequest(new Error('HTTP 503'))).toBe(true);
    expect(shouldRetryRequest(new Error('账号权限不足'))).toBe(false);
  });

  it('请求失败后按策略重试并返回成功结果', async () => {
    let attempts = 0;
    const result = await requestWithPolicy('测试接口', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('网络连接失败');
      return 'ok';
    }, { retry: true, maxAttempts: 2, retryDelayMs: 0, timeoutMs: 100 });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('关闭重试时只执行一次请求', async () => {
    let attempts = 0;
    await expect(requestWithPolicy('测试接口', async () => {
      attempts += 1;
      throw new Error('网络连接失败');
    }, { retry: false, timeoutMs: 100 })).rejects.toThrow('网络连接失败');
    expect(attempts).toBe(1);
  });

  it('业务变更不能通过 retry:true 开启自动重试', async () => {
    const task = vi.fn(async () => { throw new Error('HTTP 503'); });
    await expect(requestWithPolicy('create_feed', task, { operation: 'write', retry: true, maxAttempts: 3 }))
      .rejects.toThrow('结果未知，请先确认是否已完成');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('未结束的超时读请求会取消信号并禁止启动重叠重试', async () => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    let signal!: AbortSignal;
    const task = vi.fn((received: AbortSignal) => {
      signal = received;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const promise = requestWithPolicy('get_discovery_page_data', task, { operation: 'read', retry: true, timeoutMs: 100, retryDelayMs: 0 });
    const rejected = expect(promise).rejects.toThrow('请求超时');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);
    finish('late success');
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('已经拒绝的安全读请求允许顺序重试', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    let attempts = 0;
    const task = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        attempts += 1;
        if (attempts === 1) throw new Error('HTTP 503');
        return 'ok';
      } finally { active -= 1; }
    });
    const promise = requestWithPolicy('get_discovery_config', task, { operation: 'read', retry: true, retryDelayMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('只有审查过的读取命令可重试，新命令默认单次执行', () => {
    expect(isReadOnlyCommand('get_discovery_page_data')).toBe(true);
    expect(isReadOnlyCommand('check_login_info')).toBe(true);
    expect(isReadOnlyCommand('get_home_tab_config', { reset: false })).toBe(true);
    expect(isReadOnlyCommand('get_home_tab_config', { reset: true })).toBe(false);
    expect(isReadOnlyCommand('get_home_tab_config', { reset: 1 })).toBe(false);
    expect(isReadOnlyCommand('get_home_tab_config', { reset: '1' })).toBe(false);
    for (const command of ['create_feed', 'reply_feed', 'send_private_message', 'like_feed', 'get_unreviewed_command']) {
      expect(isReadOnlyCommand(command)).toBe(false);
    }
  });

  it('timeoutMs 为 0 时等待长请求完成而不重试', async () => {
    let attempts = 0;
    const result = await requestWithPolicy('长任务', async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'completed';
    }, { retry: false, timeoutMs: 0 });

    expect(result).toBe('completed');
    expect(attempts).toBe(1);
  });
});
