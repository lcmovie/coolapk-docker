import { router } from '../router';
import { CoolapkTauriAPI } from '../api/coolapk';
import { useSettingsStore } from '../stores/settings';
import { normalizeCoolapkRoute } from './coolapkRoute';
import { openFeedDetail } from './feedNavigation';
import { isTauri } from './runtime';

/** A download attribute only bypasses routing for browser-owned download URLs. */
function handleBrowserDownload(e: Event, anchor: HTMLAnchorElement): boolean {
  if (isTauri() || !anchor.hasAttribute('download') || !anchor.getAttribute('href')) return false;
  try {
    const url = new URL(anchor.href);
    const http = ['http:', 'https:'].includes(url.protocol);
    const localHttp = http && url.origin === window.location.origin && !url.username && !url.password;
    const localBlob = url.protocol === 'blob:' && url.origin === window.location.origin;
    const data = url.protocol === 'data:' && /^data:[^,]*,/i.test(anchor.getAttribute('href')!.trim());
    if (localHttp || localBlob || data) return true;
    // An external HTTP download still follows the external-link preference,
    // including protocol-relative URLs whose download attribute browsers ignore.
    // A download attribute must never authorize javascript:, file:, or a foreign blob.
    if (http) {
      e.preventDefault();
      void CoolapkTauriAPI.openUrl(anchor.href, useSettingsStore().settings.externalLinkMode);
      return true;
    }
  } catch { /* Malformed download URLs are blocked. */ }
  e.preventDefault();
  return true;
}

/** Fallback for anchors not already handled by vue-router or a page handler. */
export function handleGlobalAnchorClick(e: Event) {
  if (e.defaultPrevented) return;
  const anchor = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a') : null;
  if (!anchor || handleBrowserDownload(e, anchor)) return;
  const href = anchor.getAttribute('href') || '';
  if (!href || href.startsWith('/') || href.startsWith('#')) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(href)) {
    void CoolapkTauriAPI.openUrl(anchor.href, useSettingsStore().settings.externalLinkMode);
  }
}

/**
 * 统一处理富文本内 <a> 的点击：
 *  - /feed/<id> 站内动态链接 → 进入完整动态页；
 *  - 其余站内路径（/ 开头）优先走内部路由（如 /u/xxx 用户页），
 *    未命中路由时用酷安官网域名拼装，避免加载应用自身 origin 产生空白页；
 *  - http(s) 链接按设置选择应用内新窗口浏览或调起系统浏览器。
 */
export function handleAnchorClick(e: Event, feedId?: string | number) {
  const anchor = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a') : null;
  if (!anchor || handleBrowserDownload(e, anchor)) return;
  const href = anchor.getAttribute('href') || '';
  const text = anchor.textContent?.trim() || '';
  e.preventDefault();

  if (text.includes('查看更多') || !href || href === '#' || href.startsWith('javascript:')) {
    const targetId = feedId || href.match(/\d+/)?.[0];
    if (targetId) {
      openFeedDetail(router, targetId);
    }
    return;
  }

  const feedMatch = href.match(/^\/feed\/(\d+)/);
  if (feedMatch?.[1]) {
    openFeedDetail(router, feedMatch[1]);
    return;
  }

  const normalizedRoute = normalizeCoolapkRoute(href);
  if (normalizedRoute && router.resolve(normalizedRoute).matched.length) {
    void router.push(normalizedRoute);
    return;
  }

  if (href.startsWith('/')) {
    const target = !/^\/feed\//i.test(href) ? href : '';
    if (target && router.resolve(target).matched.length) {
      router.push(target);
      return;
    }
    CoolapkTauriAPI.openUrl(`https://www.coolapk.com${href}`);
    return;
  }

  CoolapkTauriAPI.openUrl(anchor.href, useSettingsStore().settings.externalLinkMode);
}
