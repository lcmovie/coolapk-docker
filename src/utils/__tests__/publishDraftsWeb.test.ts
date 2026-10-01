import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishDraftState } from '../publishDrafts';

const mocks = vi.hoisted(() => ({
  stageDraftFile: vi.fn(), readStagedFile: vi.fn(), releaseCdnFile: vi.fn(), apiRequest: vi.fn(),
  persisted: {} as Record<string, any>, files: new Map<string, File>(), sequence: 0,
  failSave: false, commitThenFail: false, trace: [] as string[],
}));
vi.mock('../runtime', () => ({ isTauri: () => false, apiRequest: mocks.apiRequest }));
vi.mock('../../api/coolapk', () => ({ CoolapkTauriAPI: mocks }));

const base: PublishDraftState = { text: '合成测试草稿', images: [], target: null, productOptions: {}, visibleStatus: 1, largeCover: false, extraOptions: {}, attachmentTitle: '' };
const photoState = (file: File): PublishDraftState => ({ ...base, images: [{ file, preview: 'data:image/jpeg;base64,not-stored' }] });

describe('网页草稿媒体在Docker中持久化', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.persisted = {}; mocks.files = new Map(); mocks.sequence = 0;
    mocks.failSave = false; mocks.commitThenFail = false; mocks.trace = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored-preview');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.stageDraftFile.mockImplementation(async (file: File) => {
      const filePath = `upload:${(++mocks.sequence).toString(16).padStart(64, '0')}`;
      mocks.files.set(filePath, file); mocks.trace.push(`stage:${filePath}`);
      return { filePath, fileName: file.name, size: file.size };
    });
    mocks.readStagedFile.mockImplementation(async (path: string) => {
      const file = mocks.files.get(path);
      if (!file) throw new Error('草稿媒体不存在');
      return file;
    });
    mocks.apiRequest.mockImplementation(async (_path: string, options?: RequestInit) => {
      if (options?.method !== 'PUT') return JSON.parse(JSON.stringify(mocks.persisted));
      mocks.trace.push('save');
      if (mocks.failSave) throw new Error('保存未确认，请先确认结果');
      mocks.persisted = JSON.parse(String(options.body));
      if (mocks.commitThenFail) throw new Error('响应丢失，请先确认结果');
      return {};
    });
    mocks.releaseCdnFile.mockImplementation(async (path: string) => {
      mocks.trace.push(`release:${path}`);
      if (JSON.stringify(mocks.persisted).includes(path)) throw new Error('409 草稿仍引用此文件');
      mocks.files.delete(path);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('256MiB视频仅存opaque元数据，不把原视频或预览编码进32MiB JSON', async () => {
    const drafts = await import('../publishDrafts');
    const file = new File(['original-video'], 'video.mov', { type: 'video/quicktime', lastModified: 123 });
    Object.defineProperty(file, 'size', { value: 256 * 1024 * 1024 });
    const cover = new File(['cover'], 'cover.jpg', { type: 'image/jpeg' });
    await drafts.saveFullPublishDraft('u', 'v', { ...base, video: { file, cover, preview: 'blob:expired', coverPreview: 'data:image/jpeg;base64,not-stored', duration: 1200 } });
    const saved = mocks.persisted.fullDrafts.u[0];
    expect(saved.state.video.file).toMatchObject({ stagedPath: expect.stringMatching(/^upload:/), name: 'video.mov', type: 'video/quicktime', lastModified: 123, size: 256 * 1024 * 1024 });
    expect(saved.state.video.file).not.toHaveProperty('data');
    expect(saved.state.video).not.toHaveProperty('preview');
    expect(saved.state.video.coverPreview).toBe('');
    expect(JSON.stringify(saved).length).toBeLessThan(1500);
    expect(mocks.stageDraftFile).toHaveBeenCalledTimes(2);
  });

  it('模块重建后读取完整原文件、实况和发布选项，恢复结果不依赖旧blobURL', async () => {
    let drafts = await import('../publishDrafts');
    const image = new File(['image-bytes'], 'photo.jpg', { type: 'image/jpeg', lastModified: 11 });
    const live = new File(['live-video'], 'live.mov', { type: 'video/quicktime', lastModified: 12 });
    await drafts.saveFullPublishDraft('u', 'live', { ...base, visibleStatus: -1, extraOptions: { originalType: 2 }, images: [{ file: image, preview: 'expired', liveVideo: live, liveEnabled: true }] });
    vi.resetModules(); drafts = await import('../publishDrafts');
    const restored = await drafts.restoreFullPublishDraft((await drafts.listFullPublishDrafts('u'))[0]!, 'u');
    expect(restored.visibleStatus).toBe(-1);
    expect(restored.extraOptions).toEqual({ originalType: 2 });
    expect(restored.images[0]?.file).toMatchObject({ name: 'photo.jpg', type: 'image/jpeg', lastModified: 11, size: image.size });
    expect(restored.images[0]?.liveVideo).toMatchObject({ name: 'live.mov', size: live.size });
    expect(restored.images[0]?.liveEnabled).toBe(true);
    expect(restored.images[0]?.preview).toMatch(/^data:image\/jpeg;base64,/);
    expect(mocks.readStagedFile).toHaveBeenCalledTimes(2);
    await drafts.saveFullPublishDraft('u', 'live', { ...restored, text: '改正文' });
    expect(mocks.stageDraftFile).toHaveBeenCalledTimes(2);
  });

  it('同一File在不同账号草稿独占token，删一篇不释放另一篇', async () => {
    const drafts = await import('../publishDrafts');
    const image = new File(['image'], 'same.jpg');
    await drafts.saveFullPublishDraft('one', 'same-id', photoState(image));
    await drafts.saveFullPublishDraft('two', 'same-id', photoState(image));
    const one = mocks.persisted.fullDrafts.one[0].state.images[0].file.stagedPath;
    const two = mocks.persisted.fullDrafts.two[0].state.images[0].file.stagedPath;
    expect(one).not.toBe(two);
    await drafts.deleteFullPublishDraft('one', 'same-id');
    expect(mocks.releaseCdnFile).toHaveBeenCalledExactlyOnceWith(one);
    expect(mocks.files.has(two)).toBe(true);
    expect(await drafts.listFullPublishDrafts('two')).toHaveLength(1);
  });

  it('替换媒体保存成功后才释放旧token，重复正文保存复用本草稿媒体', async () => {
    const drafts = await import('../publishDrafts');
    const original = new File(['old'], 'old.jpg');
    const replacement = new File(['new'], 'new.jpg');
    await drafts.saveFullPublishDraft('u', 'd', photoState(original));
    const oldPath = mocks.persisted.fullDrafts.u[0].state.images[0].file.stagedPath;
    mocks.trace = [];
    await drafts.saveFullPublishDraft('u', 'd', photoState(replacement));
    expect(mocks.trace[1]).toBe('save');
    expect(mocks.trace[2]).toBe(`release:${oldPath}`);
    await drafts.saveFullPublishDraft('u', 'd', { ...photoState(replacement), text: '正文变化' });
    expect(mocks.stageDraftFile).toHaveBeenCalledTimes(2);
    expect(mocks.files.has(oldPath)).toBe(false);
  });

  it('保存失败恢复旧缓存及旧草稿，只释放新文件且不自动二次写', async () => {
    const drafts = await import('../publishDrafts');
    await drafts.saveFullPublishDraft('u', 'd', photoState(new File(['old'], 'old.jpg')));
    const oldPath = mocks.persisted.fullDrafts.u[0].state.images[0].file.stagedPath;
    mocks.failSave = true; mocks.apiRequest.mockClear();
    await expect(drafts.saveFullPublishDraft('u', 'd', photoState(new File(['new'], 'new.jpg')))).rejects.toThrow('保存未确认');
    expect((await drafts.listFullPublishDrafts('u'))[0]?.state.images[0]?.file?.stagedPath).toBe(oldPath);
    expect(mocks.persisted.fullDrafts.u[0].state.images[0].file.stagedPath).toBe(oldPath);
    expect(mocks.files.has(oldPath)).toBe(true);
    expect(mocks.files.size).toBe(1);
    expect(mocks.apiRequest.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });

  it('保存响应丢失时服务端引用保护保留新媒体，重载可恢复已保存结果', async () => {
    let drafts = await import('../publishDrafts');
    mocks.commitThenFail = true;
    await expect(drafts.saveFullPublishDraft('u', 'd', photoState(new File(['new'], 'new.jpg')))).rejects.toThrow('响应丢失');
    const serverPath = mocks.persisted.fullDrafts.u[0].state.images[0].file.stagedPath;
    expect(mocks.files.has(serverPath)).toBe(true);
    vi.resetModules(); drafts = await import('../publishDrafts');
    const restored = await drafts.restoreFullPublishDraft((await drafts.listFullPublishDrafts('u'))[0]!, 'u');
    expect(restored.images[0]?.file?.name).toBe('new.jpg');
  });

  it('暂存部分失败释放本轮新文件，删除保存失败时不释放旧文件', async () => {
    const drafts = await import('../publishDrafts');
    await drafts.saveFullPublishDraft('u', 'd', photoState(new File(['old'], 'old.jpg')));
    const oldPath = mocks.persisted.fullDrafts.u[0].state.images[0].file.stagedPath;
    mocks.stageDraftFile.mockResolvedValueOnce({ filePath: 'upload:new-part', fileName: 'new.jpg', size: 1 }).mockRejectedValueOnce(new Error('空间不足'));
    await expect(drafts.saveFullPublishDraft('u', 'd', { ...base, images: [{ file: new File(['a'], 'a.jpg'), preview: '' }, { file: new File(['b'], 'b.jpg'), preview: '' }] })).rejects.toThrow('空间不足');
    expect(mocks.releaseCdnFile).toHaveBeenCalledWith('upload:new-part');
    mocks.failSave = true; mocks.releaseCdnFile.mockClear();
    await expect(drafts.deleteFullPublishDraft('u', 'd')).rejects.toThrow('保存未确认');
    expect(mocks.releaseCdnFile).not.toHaveBeenCalled();
    expect(mocks.files.has(oldPath)).toBe(true);
  });

  it('原文件缺失或损坏时整篇恢复失败，不静默丢媒体', async () => {
    const drafts = await import('../publishDrafts');
    await drafts.saveFullPublishDraft('u', 'd', photoState(new File(['original'], 'original.jpg')));
    const draft = (await drafts.listFullPublishDrafts('u'))[0]!;
    mocks.readStagedFile.mockResolvedValueOnce(new Blob(['bad']));
    await expect(drafts.restoreFullPublishDraft(draft)).rejects.toThrow('大小不符');
    mocks.readStagedFile.mockRejectedValueOnce(new Error('草稿媒体不存在'));
    await expect(drafts.restoreFullPublishDraft(draft)).rejects.toThrow('不存在');
  });
});
