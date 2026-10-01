import { afterEach, describe, it, expect, vi } from 'vitest';
import { DEVELOPER_UID, getFeedbackTemplate, openFeedbackPage, openFeedbackMessage } from '../feedback';
import { CoolapkTauriAPI } from '../../api/coolapk';
import { PROJECT_ISSUES_URL } from '../../constants/app';

vi.mock('../../api/coolapk', () => ({ CoolapkTauriAPI: { openUrl: vi.fn().mockResolvedValue(undefined) } }));

afterEach(() => vi.unstubAllGlobals());

describe('feedback utils', () => {
  it.each([
    ['Mozilla/5.0 (Linux; Android 14)', 'Android'],
    ['Mozilla/5.0 (Linux; android 14)', 'Android'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'iOS'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 'iOS'],
    ['Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)', 'iOS'],
  ])('系统识别：%s → %s', (userAgent, osName) => {
    vi.stubGlobal('navigator', { userAgent });
    expect(getFeedbackTemplate()).toContain(`- 操作系统：${osName}\n`);
  });

  it.each([
    [5, 'iOS'],
    [0, 'macOS'],
  ])('Macintosh UA 的触摸点数为 %s 时识别为 %s', (maxTouchPoints, osName) => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      maxTouchPoints,
    });
    expect(getFeedbackTemplate()).toContain(`- 操作系统：${osName}\n`);
  });

  it('开发者 UID 正确', () => {
    expect(DEVELOPER_UID).toBe('1451266');
  });

  it('生成包含版本号和系统的反馈模版', () => {
    const template = getFeedbackTemplate();
    expect(template).toContain('【酷安docker版问题反馈】');
    expect(template).toContain('客户端版本：');
    expect(template).toContain('操作系统：');
    expect(template).toContain('问题描述：');
  });

  it('反馈无需酷安账号，直接打开本项目 GitHub Issues', async () => {
    await openFeedbackPage();
    expect(CoolapkTauriAPI.openUrl).toHaveBeenCalledWith(PROJECT_ISSUES_URL, 'system');
  });

  it('反馈链接不再指向原作者私信或上游仓库', async () => {
    vi.mocked(CoolapkTauriAPI.openUrl).mockClear();
    await openFeedbackPage();
    expect(CoolapkTauriAPI.openUrl).toHaveBeenCalledOnce();
    expect(CoolapkTauriAPI.openUrl).toHaveBeenCalledWith('https://github.com/lcmovie/coolapk-docker/issues', 'system');
  });

  it('旧反馈入口不发私信或要求酷安登录', async () => {
    const router = { push: vi.fn() };
    const auth = { isLoggedIn: false, openLoginModal: vi.fn() };
    await openFeedbackMessage(router, auth);
    expect(router.push).not.toHaveBeenCalled();
    expect(auth.openLoginModal).not.toHaveBeenCalled();
    expect(CoolapkTauriAPI.openUrl).toHaveBeenLastCalledWith(PROJECT_ISSUES_URL, 'system');
  });
});
