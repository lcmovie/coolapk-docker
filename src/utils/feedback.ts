import { APP_VERSION } from '../constants/version';
import { APP_DISPLAY_NAME, PROJECT_ISSUES_URL } from '../constants/app';
import { CoolapkTauriAPI } from '../api/coolapk';

// 仅用于兼容旧私信链接中的原作者昵称，不再作为反馈收件人。
export const DEVELOPER_UID = '1451266';
export const DEVELOPER_USERNAME = 'oxygen的喵';

export function getFeedbackTemplate(): string {
  let osName = 'Windows';
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent;
    // Android UA 同时包含 Linux，必须先识别 Android。
    if (/android/i.test(ua)) {
      osName = 'Android';
    } else if (/iphone|ipad|ipod/i.test(ua)
      || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) {
      // iOS UA 包含 Mac OS；iPad 桌面模式会使用 Macintosh UA。
      osName = 'iOS';
    } else if (ua.includes('Macintosh') || ua.includes('Mac OS')) {
      osName = 'macOS';
    } else if (ua.includes('Linux')) {
      osName = 'Linux';
    } else if (ua.includes('Windows')) {
      osName = 'Windows';
    }
  }

  return `【${APP_DISPLAY_NAME}问题反馈】
- 客户端版本：v${APP_VERSION}
- 操作系统：${osName}
- 问题描述：
- 复现步骤：`;
}

export function openFeedbackPage() {
  return CoolapkTauriAPI.openUrl(PROJECT_ISSUES_URL, 'system');
}

/** Compatibility entry point; feedback opens this project's Issues without sending private messages. */
export function openFeedbackMessage(_router?: unknown, _authStore?: unknown) {
  return openFeedbackPage();
}
