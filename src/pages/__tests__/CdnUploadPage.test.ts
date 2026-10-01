import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  push: vi.fn(),
  uploadFileToCdn: vi.fn(),
  stageCdnFile: vi.fn(),
  releaseCdnFile: vi.fn(),
  showToast: vi.fn(),
  nativeRuntime: true,
}));

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => mocks.nativeRuntime, invoke: vi.fn() }));
vi.mock('../../utils/toast', () => ({ showToast: mocks.showToast }));
vi.mock('../../api/coolapk', () => ({ CoolapkTauriAPI: mocks }));

import CdnUploadPage from '../CdnUploadPage.vue';
import { useUploadStore } from '../../stores/uploads';

describe('酷安 CDN 文件上传入口', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.nativeRuntime = true;
    mocks.stageCdnFile.mockResolvedValue({ filePath: 'upload:browser-token', fileName: 'sample.zip', size: 7 });
    mocks.releaseCdnFile.mockResolvedValue(undefined);
    mocks.open.mockResolvedValue(['C:\\upload\\sample.zip']);
    mocks.uploadFileToCdn.mockResolvedValue({ code: 200, data: 'https://image.coolapk.com/sample.zip' });
  });

  it('选择文件后加入全局队列并跳转到上传任务管理页', async () => {
    const wrapper = mount(CdnUploadPage);
    await wrapper.find('.upload-picker-panel button').trigger('click');
    await flushPromises();

    const store = useUploadStore();
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]?.fileName).toBe('sample.zip');
    expect(mocks.uploadFileToCdn).toHaveBeenCalledWith(store.tasks[0]?.id, 'C:\\upload\\sample.zip', store.tasks[0]?.attempt);
    expect(mocks.push).toHaveBeenCalledWith({ path: '/downloads', query: { mode: 'upload', tab: 'active' } });
  });

  it('网页用原始File暂存后串行上传，不请求本机目录或Tauri文件选择器', async () => {
    mocks.nativeRuntime = false;
    mocks.uploadFileToCdn.mockImplementation(() => new Promise(() => {}));
    const wrapper = mount(CdnUploadPage);
    const file = new File(['payload'], 'sample.zip', { type: 'application/zip' });
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.stageCdnFile).toHaveBeenCalledExactlyOnceWith(file);
    const task = useUploadStore().tasks[0]!;
    expect(task.filePath).toBe('upload:browser-token');
    expect(task.total).toBe(7);
    expect(mocks.uploadFileToCdn).toHaveBeenCalledWith(task.id, 'upload:browser-token', task.attempt);
    expect(mocks.push).toHaveBeenCalledWith({ path: '/downloads', query: { mode: 'upload', tab: 'active' } });
  });

  it('网页暂存失败或超限时不创建上传请求，也不自动重试', async () => {
    mocks.nativeRuntime = false;
    mocks.stageCdnFile.mockRejectedValue(new Error('本地存储空间不足'));
    const wrapper = mount(CdnUploadPage);
    const input = wrapper.get('input[type="file"]');
    const file = new File(['small'], 'failed.bin');
    const large = new File([], 'large.bin');
    Object.defineProperty(large, 'size', { value: 256 * 1024 * 1024 + 1 });
    Object.defineProperty(input.element, 'files', { value: [file, large], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(mocks.stageCdnFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(mocks.uploadFileToCdn).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('存储空间不足'), 'error');
    expect(mocks.showToast).toHaveBeenCalledWith(expect.stringContaining('256 MB'), 'error');
  });
});
