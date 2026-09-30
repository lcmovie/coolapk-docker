import { APP_VERSION } from '../constants/version';
import { APP_DISPLAY_NAME, SUPPORT_GITHUB_URL } from '../constants/app';
import { CoolapkTauriAPI } from '../api/coolapk';

// 仅用于兼容旧私信链接中的原作者昵称，不再作为反馈收件人。
export const DEVELOPER_UID = '1451266';
export const DEVELOPER_USERNAME = 'oxygen的喵';

export function getFeedbackTemplate(): string {
  let osName = 'Windows';
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent;
    if (ua.includes('Macintosh') || ua.includes('Mac OS')) {
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
  return CoolapkTauriAPI.openUrl(SUPPORT_GITHUB_URL, 'system');
}
