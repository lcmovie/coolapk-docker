import { describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));
import { CoolapkTauriAPI } from '../coolapk';

describe('web external link boundary', () => {
  it('rejects executable schemes without passing them to the browser fallback', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await expect(CoolapkTauriAPI.openUrl('javascript:alert(1)', 'system')).rejects.toThrow('不支持的链接协议');
    await expect(CoolapkTauriAPI.openUrl('file:///etc/passwd', 'system')).rejects.toThrow('不支持的链接协议');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
