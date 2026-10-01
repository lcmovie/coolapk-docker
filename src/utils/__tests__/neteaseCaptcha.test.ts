import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_COOLAPK_CAPTCHA_ID,
  extractCaptchaParamsFromError,
  loadNECaptchaScript,
  verifyWithCaptcha,
  type NECaptchaConfig,
  type NECaptchaInstance,
} from '../neteaseCaptcha';

describe('neteaseCaptcha', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.head.innerHTML = '';
    delete (window as any).initNECaptcha;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.initNECaptcha;
  });

  it('exports default coolapk captcha id', () => {
    expect(DEFAULT_COOLAPK_CAPTCHA_ID).toBe('414e5c9b866a03db03f860a1a9101672');
  });

  it('解析仅返回 403 的验证码响应，且不误判普通 403', () => {
    expect(extractCaptchaParamsFromError(JSON.stringify({ code: 403, messageStatus: 'err_request_captcha_v2' }))).toEqual({ captchaId: DEFAULT_COOLAPK_CAPTCHA_ID, captchaField: '_v2_post_token' });
    expect(extractCaptchaParamsFromError(JSON.stringify({ code: 403, message: '无权访问' }))).toBeNull();
  });

  it('loads the script tag into DOM', async () => {
    const promise = loadNECaptchaScript();
    const script = document.querySelector('script[src*="load.min.js"]');
    expect(script).toBeTruthy();

    (window as any).initNECaptcha = vi.fn();
    script?.dispatchEvent(new Event('load'));
    await promise;
  });

  it('脚本失败后移除标签，并让并发调用共享失败后重新加载', async () => {
    const first = loadNECaptchaScript();
    expect(loadNECaptchaScript()).toBe(first);
    const failure = expect(first).rejects.toThrow('脚本加载失败');
    const failedScript = document.querySelector('script')!;
    failedScript.dispatchEvent(new Event('error'));
    await failure;
    expect(failedScript.isConnected).toBe(false);

    const retry = loadNECaptchaScript();
    const newScript = document.querySelector('script')!;
    expect(newScript).not.toBe(failedScript);
    window.initNECaptcha = vi.fn();
    newScript.dispatchEvent(new Event('load'));
    await retry;
  });

  it.each([false, true])('脚本无事件时超时清理，已有标签=%s', async (existing) => {
    vi.useFakeTimers();
    if (existing) {
      // 模拟旧代码遗留的失败标签，历史 error 事件不会再次触发。
      const script = document.createElement('script');
      script.src = 'https://cstaticdun.126.net/load.min.js';
      document.head.appendChild(script);
      script.dispatchEvent(new Event('error'));
    }
    const failure = expect(loadNECaptchaScript()).rejects.toThrow('脚本加载超时');
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(document.querySelector('script')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    const retry = loadNECaptchaScript();
    window.initNECaptcha = vi.fn();
    document.querySelector('script')!.dispatchEvent(new Event('load'));
    await retry;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('脚本加载后没有初始化函数也会清理标签并允许重试', async () => {
    const failure = expect(loadNECaptchaScript()).rejects.toThrow('初始化函数不可用');
    document.querySelector('script')!.dispatchEvent(new Event('load'));
    await failure;
    expect(document.querySelector('script')).toBeNull();
  });

  it('resolves formatted token on successful validation', async () => {
    const verify = vi.fn();
    (window as any).initNECaptcha = vi.fn((config, onLoad) => {
      const mockInstance = {
        verify,
        refresh: vi.fn(),
        destroy: vi.fn(),
      };
      if (onLoad) onLoad(mockInstance);
      if (config.onReady) config.onReady(mockInstance);
      // Simulate verify success
      if (config.onVerify) {
        config.onVerify(null, { validate: 'mock_validate_hash_12345' });
      }
    });

    const token = await verifyWithCaptcha('414e5c9b866a03db03f860a1a9101672');
    expect(token).toBe('NEC:414e5c9b:mock_validate_hash_12345');
    expect(verify).toHaveBeenCalledOnce();
    expect(window.initNECaptcha).toHaveBeenCalledWith(expect.objectContaining({ mode: 'popup', apiVersion: 2 }), expect.any(Function), expect.any(Function));
  });

  it('rejects on user cancellation or verify error', async () => {
    (window as any).initNECaptcha = vi.fn((config, onLoad) => {
      const mockInstance = {
        verify: vi.fn(),
        refresh: vi.fn(),
        destroy: vi.fn(),
      };
      if (onLoad) onLoad(mockInstance);
      if (config.onClose) {
        config.onClose();
      }
    });

    await expect(verifyWithCaptcha()).rejects.toThrow('用户取消了人机验证');
  });

  it.each(['verify', 'popUp', 'popup'] as const)('支持异步加载的 %s 方法和无参数 onReady，取消时清理实例', async (method) => {
    let config!: NECaptchaConfig;
    let onLoad!: (instance: NECaptchaInstance) => void;
    window.initNECaptcha = vi.fn((options, loaded) => {
      config = options;
      onLoad = loaded!;
    });
    const open = vi.fn();
    const instance = { [method]: open, destroy: vi.fn() } as NECaptchaInstance;
    const rejection = expect(verifyWithCaptcha()).rejects.toThrow('用户取消了人机验证');
    await vi.waitFor(() => expect(onLoad).toBeTypeOf('function'));
    try {
      expect(() => onLoad(instance)).not.toThrow();
      config.onReady?.();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      config.onClose?.();
      await rejection;
    }
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[id^="ne-captcha-"]')).toBeNull();
  });

  it('优先使用官方 v2 verify 方法，并保留实例的 this', async () => {
    const instance: NECaptchaInstance = {
      verify: vi.fn(function (this: NECaptchaInstance) { expect(this).toBe(instance); }),
      popUp: vi.fn(),
      popup: vi.fn(),
      destroy: vi.fn(),
    };
    window.initNECaptcha = vi.fn((config, onLoad) => {
      expect(config.apiVersion).toBe(2);
      onLoad?.(instance);
      config.onClose?.();
    });
    await expect(verifyWithCaptcha()).rejects.toThrow('用户取消了人机验证');
    expect(instance.verify).toHaveBeenCalledTimes(1);
    expect(instance.popUp).not.toHaveBeenCalled();
    expect(instance.popup).not.toHaveBeenCalled();
  });

  it('onReady 早于 onload、重复加载和 destroy 触发关闭时只弹出和清理一次', async () => {
    const instance = { verify: vi.fn(), destroy: vi.fn() };
    window.initNECaptcha = vi.fn((config, onLoad) => {
      instance.destroy.mockImplementation(() => config.onClose?.());
      config.onReady?.(instance);
      config.onReady?.();
      onLoad?.(instance);
      onLoad?.(instance);
      config.onClose?.();
      onLoad?.(instance);
      config.onVerify?.(null, { validate: 'late-result' });
    });
    await expect(verifyWithCaptcha()).rejects.toThrow('用户取消了人机验证');
    expect(instance.verify).toHaveBeenCalledTimes(1);
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[id^="ne-captcha-"]')).toBeNull();
  });

  it.each(['missing', 'throws'] as const)('异步弹窗方法 %s 时结束请求并清理，不产生未捕获异常', async (failure) => {
    let onLoad!: (instance: NECaptchaInstance) => void;
    window.initNECaptcha = vi.fn((_config, loaded) => { onLoad = loaded!; });
    const instance: NECaptchaInstance = { destroy: vi.fn() };
    if (failure === 'throws') instance.popUp = vi.fn(() => { throw new Error('SDK 弹窗异常'); });
    const rejection = expect(verifyWithCaptcha()).rejects.toThrow(failure === 'missing' ? '弹窗方法不可用' : 'SDK 弹窗异常');
    await vi.waitFor(() => expect(onLoad).toBeTypeOf('function'));
    expect(() => onLoad(instance)).not.toThrow();
    await rejection;
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[id^="ne-captcha-"]')).toBeNull();
  });

  it('初始化函数同步抛出异常时移除挂载容器', async () => {
    window.initNECaptcha = vi.fn(() => { throw new Error('SDK 初始化异常'); });
    await expect(verifyWithCaptcha()).rejects.toThrow('SDK 初始化异常');
    expect(document.querySelector('[id^="ne-captcha-"]')).toBeNull();
  });

  it('初始化没有回调时超时，晚到的实例会清理且不会再弹出', async () => {
    vi.useFakeTimers();
    let onLoad!: (instance: NECaptchaInstance) => void;
    window.initNECaptcha = vi.fn((_config, loaded) => { onLoad = loaded!; });
    const rejection = expect(verifyWithCaptcha()).rejects.toThrow('初始化超时');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    const instance = { verify: vi.fn(), destroy: vi.fn() };
    onLoad(instance);
    expect(instance.verify).not.toHaveBeenCalled();
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[id^="ne-captcha-"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('人工验证没有完成或关闭回调时三分钟超时释放请求', async () => {
    vi.useFakeTimers();
    let config!: NECaptchaConfig;
    const instance = { verify: vi.fn(), destroy: vi.fn() };
    window.initNECaptcha = vi.fn((options, onLoad) => {
      config = options;
      onLoad?.(instance);
      options.onReady?.();
    });
    const rejection = expect(verifyWithCaptcha()).rejects.toThrow('人机验证等待超时');
    await vi.advanceTimersByTimeAsync(179_999);
    expect(instance.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    config.onClose?.();
    config.onVerify?.(null, { validate: 'late-result' });
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[id^="ne-captcha-"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('验证回调早于 onload 时保留成功结果并清理晚到的实例', async () => {
    const instance = { verify: vi.fn(), destroy: vi.fn() };
    window.initNECaptcha = vi.fn((config, onLoad) => {
      config.onVerify?.(null, { validate: 'verified-before-load' });
      onLoad?.(instance);
      config.onReady?.(instance);
      config.onClose?.();
    });
    await expect(verifyWithCaptcha()).resolves.toBe('NEC:414e5c9b:verified-before-load');
    expect(instance.verify).not.toHaveBeenCalled();
    expect(instance.destroy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[id^="ne-captcha-"]')).toBeNull();
  });
});
