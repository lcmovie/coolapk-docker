import { describe, it, expect, vi } from 'vitest';
import { DEVELOPER_UID, getFeedbackTemplate, openFeedbackPage } from '../feedback';
import { CoolapkTauriAPI } from '../../api/coolapk';
import { SUPPORT_GITHUB_URL } from '../../constants/app';

vi.mock('../../api/coolapk', () => ({ CoolapkTauriAPI: { openUrl: vi.fn().mockResolvedValue(undefined) } }));

describe('feedback utils', () => {
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

  it('反馈无需酷安账号，直接打开维护者 GitHub 主页', async () => {
    await openFeedbackPage();
    expect(CoolapkTauriAPI.openUrl).toHaveBeenCalledWith(SUPPORT_GITHUB_URL, 'system');
  });

  it('反馈链接不再指向原作者私信或上游仓库', async () => {
    vi.mocked(CoolapkTauriAPI.openUrl).mockClear();
    await openFeedbackPage();
    expect(CoolapkTauriAPI.openUrl).toHaveBeenCalledOnce();
    expect(CoolapkTauriAPI.openUrl).toHaveBeenCalledWith('https://github.com/lcmovie', 'system');
  });
});
