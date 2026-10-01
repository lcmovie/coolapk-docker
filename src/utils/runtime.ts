import { invoke as nativeInvoke, isTauri as nativeIsTauri } from '@tauri-apps/api/core';
import { listen as nativeListen, type Event as TauriEvent, type UnlistenFn } from '@tauri-apps/api/event';
import { explainUncertainWrite, isReadOnlyCommand, WEB_REQUEST_TIMEOUT_MS } from './requestCenter';
export type { UnlistenFn } from '@tauri-apps/api/event';

/** Keep business calls identical across the desktop application and the web server. */
export function isTauri(): boolean {
  if (typeof nativeIsTauri === 'function') return nativeIsTauri();
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event('coolapk-access-expired'));
    throw new Error('网页访问会话已过期，请重新输入访问密码');
  }
  if (!response.ok) throw new Error(payload?.error || `服务请求失败（${response.status}）`);
  return payload as T;
}

type WebInvokeOptions = { signal?: AbortSignal; timeoutMs?: number };

async function invokeHttp<T>(command: string, args: Record<string, any>, options: WebInvokeOptions): Promise<T> {
  const controller = new AbortController();
  let rejectCancelled!: (reason: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const abortFromCaller = () => {
    rejectCancelled(new DOMException('The request was aborted', 'AbortError'));
    controller.abort();
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  // APK downloads return after streaming finishes and already have progress,
  // pause and cancel controls. Match the server's streaming deadline exemption.
  const timeoutMs = options.timeoutMs ?? (command === 'start_apk_download' ? undefined : WEB_REQUEST_TIMEOUT_MS);
  const timer = timeoutMs === undefined ? undefined : window.setTimeout(() => {
    rejectCancelled(new Error(`${command}请求超时`));
    controller.abort();
  }, timeoutMs);
  try {
    // Abort only cancels browser transport/waiting; it cannot roll back a write
    // already received by the upstream service.
    if (controller.signal.aborted) return await cancelled;
    return await Promise.race([apiRequest<T>(`/api/invoke/${encodeURIComponent(command)}`, {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify(args, (_key, value) => {
        if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
        return value;
      }),
    }), cancelled]);
  } catch (error) {
    throw isReadOnlyCommand(command, args) ? error : explainUncertainWrite(error);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function invoke<T = unknown>(command: string, args: Record<string, any> = {}, options: WebInvokeOptions = {}): Promise<T> {
  if (isTauri()) return nativeInvoke<T>(command, args);
  if (command === 'open_url') {
    const url = new URL(String(args.url), location.href);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('不支持的链接协议');
    window.open(url.href, '_blank', 'noopener,noreferrer');
    return undefined as T;
  }
  if (command === 'open_image_in_system_viewer') {
    window.open(mediaProxyUrl(String(args.url)), '_blank', 'noopener,noreferrer');
    return String(args.url) as T;
  }
  if (command === 'pick_font_family') {
    return window.prompt('输入字体名称（字体需要已安装在当前浏览器所在的设备上）', args.currentFont || '') as T;
  }
  if (['set_window_theme', 'set_close_to_tray', 'set_startup_flags', 'close_login_window', 'quit_app', 'cleanup_update_packages'].includes(command)) {
    return undefined as T;
  }
  if (['open_login_webview', 'sync_login_webview'].includes(command)) {
    throw new Error('Docker版请使用 Cookie 凭据导入；浏览器无法自动读取酷安官网的 Cookie');
  }
  if (['install_update', 'download_update'].includes(command)) throw new Error('Docker版通过 Docker Compose 更新镜像');
  if (command === 'get_update_distribution') return 'installer' as T;
  if (command === 'is_update_package_available') return false as T;
  if (['open_apk_download_directory', 'open_cache_directory'].includes(command)) {
    const result = await invokeHttp<string>(command, args, options);
    if (command === 'open_apk_download_directory') {
      const { router } = await import('../router');
      await router.push('/files');
    } else window.alert(`缓存目录：${result}（保存在 Docker 安装目录的 data 下）`);
    return result as T;
  }
  return invokeHttp<T>(command, args, options);
}

export async function listen<T>(eventName: string, handler: (event: TauriEvent<T>) => void): Promise<UnlistenFn> {
  if (isTauri()) return nativeListen<T>(eventName, handler);
  // Container tasks also return their final result. SSE supplies progress while the tab is open.
  if (eventName !== 'apk-download-progress' || typeof EventSource === 'undefined') return () => {};
  const source = new EventSource('/api/events');
  const listener = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      if (event.type === eventName) handler({ event: eventName, id: 0, payload: data });
      else if (data.event === eventName) handler({ event: eventName, id: 0, payload: data.payload });
    } catch { /* Ignore unrelated or incomplete event frames. */ }
  };
  source.addEventListener('message', listener);
  source.addEventListener(eventName, listener as EventListener);
  return () => source.close();
}

export function mediaProxyUrl(url: string): string {
  return isTauri() || !/^https?:\/\//i.test(url) ? url : `/api/media?url=${encodeURIComponent(url)}`;
}

export function downloadText(content: string, fileName: string, mime = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
