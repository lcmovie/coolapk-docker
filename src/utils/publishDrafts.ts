import { readTauriStoreValue, updateTauriStoreValue } from './tauriStore';
import { readFilePreview, type PublishImage } from './publishMedia';
import type { PublishVideo } from './publishVideo';
import type { PublishTarget, PublishOptions } from '../types/publish';
import { CoolapkTauriAPI } from '../api/coolapk';
import { isTauri } from './runtime';

export interface PublishDraftState {
  text: string;
  images: PublishImage[];
  target: PublishTarget | null;
  productOptions: PublishOptions;
  visibleStatus: 1 | -1;
  largeCover: boolean;
  extraOptions: PublishOptions;
  attachmentTitle: string;
  video?: PublishVideo;
}
interface StoredFile { data?: string; stagedPath?: string; name: string; type: string; lastModified: number; size?: number }
interface StoredImage { preview: string; url?: string; file?: StoredFile; liveVideo?: StoredFile; liveEnabled?: boolean; liveIdentifier?: string; hdr?: number }
export interface FullPublishDraft { id: string; title: string; updatedAt: number; state: Omit<PublishDraftState, 'images' | 'video'> & { images: StoredImage[]; video?: Omit<PublishVideo, 'file' | 'cover' | 'preview'> & { file: StoredFile; cover: StoredFile } } }
type FullDraftMap = Record<string, FullPublishDraft[]>;
const serializedFiles = new WeakMap<File, Promise<StoredFile>>();
// Each draft owns its staged media. A File reused in another draft gets a different token.
const stagedFilesByDraft = new Map<string, WeakMap<File, StoredFile>>();
const validStagedPaths = new Set<string>();
const draftWrites = new Map<string, Promise<void>>();

// 文件编码按对象缓存，输入正文时不重复读取已选择的图片和视频。
async function serializeFile(file: File, owner: string, newPaths: Set<string>): Promise<StoredFile> {
  if (!isTauri()) {
    let cache = stagedFilesByDraft.get(owner);
    if (!cache) { cache = new WeakMap(); stagedFilesByDraft.set(owner, cache); }
    const cached = cache.get(file);
    if (cached?.stagedPath && validStagedPaths.has(cached.stagedPath)) return cached;
    const staged = await CoolapkTauriAPI.stageDraftFile(file);
    const value = { stagedPath: staged.filePath, name: file.name, type: file.type, lastModified: file.lastModified, size: file.size };
    newPaths.add(staged.filePath);
    validStagedPaths.add(staged.filePath);
    cache.set(file, value);
    return value;
  }
  let value = serializedFiles.get(file);
  if (!value) { value = readFilePreview(file).then((data) => ({ data, name: file.name, type: file.type, lastModified: file.lastModified })); serializedFiles.set(file, value); }
  return value;
}
async function restoreFile(file: StoredFile, owner?: string): Promise<File> {
  if (file.stagedPath) {
    if (isTauri()) throw new Error('此草稿媒体保存在 Docker 中，请通过网页恢复');
    const blob = await CoolapkTauriAPI.readStagedFile(file.stagedPath);
    if (file.size !== undefined && blob.size !== file.size) throw new Error('草稿媒体文件大小不符，请保留草稿并检查存储');
    const restored = new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
    if (owner) {
      let cache = stagedFilesByDraft.get(owner);
      if (!cache) { cache = new WeakMap(); stagedFilesByDraft.set(owner, cache); }
      cache.set(restored, file);
      validStagedPaths.add(file.stagedPath);
    }
    return restored;
  }
  const data = file.data || '';
  const comma = data.indexOf(',');
  if (comma < 0 || !data.slice(0, comma).endsWith(';base64')) throw new Error('草稿媒体数据格式无效');
  const bytes = Uint8Array.from(atob(data.slice(comma + 1)), (char) => char.charCodeAt(0));
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}

function stagedPaths(draft?: FullPublishDraft): Set<string> {
  const paths = new Set<string>();
  for (const image of draft?.state.images || []) {
    if (image.file?.stagedPath) paths.add(image.file.stagedPath);
    if (image.liveVideo?.stagedPath) paths.add(image.liveVideo.stagedPath);
  }
  if (draft?.state.video?.file.stagedPath) paths.add(draft.state.video.file.stagedPath);
  if (draft?.state.video?.cover.stagedPath) paths.add(draft.state.video.cover.stagedPath);
  return paths;
}

async function releasePaths(paths: Iterable<string>): Promise<void> {
  await Promise.all([...paths].map(async (path) => {
    try {
      await CoolapkTauriAPI.releaseCdnFile(path);
      validStagedPaths.delete(path);
    } catch {
      // The server protects tokens referenced by a committed draft, including a lost save response.
      console.warn('草稿媒体清理未完成，已保留文件，请先确认草稿保存结果');
    }
  }));
}

export async function listFullPublishDrafts(uid: string): Promise<FullPublishDraft[]> {
  const map = await readTauriStoreValue<FullDraftMap>('publish_drafts.json', 'fullDrafts');
  const existing = Array.isArray(map?.[uid]) ? map[uid].filter((draft) => draft && draft.id && draft.state && typeof draft.state.text === 'string') : [];
  if (existing.length) return [...existing].sort((a, b) => b.updatedAt - a.updatedAt);
  // 迁移旧版单篇文字草稿；保存成功后才清除旧记录。
  const text = await loadPublishDraft(uid);
  if (!text.trim()) return [];
  await saveFullPublishDraft(uid, crypto.randomUUID(), { text, images: [], target: null, productOptions: {}, visibleStatus: 1, largeCover: false, extraOptions: {}, attachmentTitle: '' });
  await clearPublishDraft(uid);
  const migrated = await readTauriStoreValue<FullDraftMap>('publish_drafts.json', 'fullDrafts');
  return migrated?.[uid] || [];
}

export function saveFullPublishDraft(uid: string, id: string, state: PublishDraftState): Promise<void> {
  const key = `${uid}:${id}`;
  const previous = draftWrites.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeFullPublishDraft(uid, id, state));
  draftWrites.set(key, next);
  return next;
}

async function writeFullPublishDraft(uid: string, id: string, state: PublishDraftState): Promise<void> {
  const newPaths = new Set<string>();
  const owner = `${uid}:${id}`;
  let previousDraft: FullPublishDraft | undefined;
  try {
    const images: StoredImage[] = [];
    for (const image of state.images) images.push({
      preview: !isTauri() && image.file ? '' : image.preview,
      url: image.url, liveEnabled: image.liveEnabled, liveIdentifier: image.liveIdentifier, hdr: image.hdr,
      file: image.file ? await serializeFile(image.file, owner, newPaths) : undefined,
      liveVideo: image.liveVideo ? await serializeFile(image.liveVideo, owner, newPaths) : undefined,
    });
    const video = state.video ? {
      file: await serializeFile(state.video.file, owner, newPaths), cover: await serializeFile(state.video.cover, owner, newPaths),
      coverPreview: isTauri() ? state.video.coverPreview : '', duration: state.video.duration,
      mediaUrl: state.video.mediaUrl, mediaInfo: state.video.mediaInfo,
    } : undefined;
    const draft: FullPublishDraft = { id, title: state.text.trim().slice(0, 40) || state.target?.title || state.attachmentTitle || (video ? '视频草稿' : images.length ? '图片草稿' : '新草稿'), updatedAt: Date.now(), state: { ...state, images, video } };
    await updateTauriStoreValue<FullDraftMap>('publish_drafts.json', 'fullDrafts', {}, (map) => {
      previousDraft = map[uid]?.find(item => item.id === id);
      return { ...map, [uid]: [draft, ...(map[uid] || []).filter(item => item.id !== id)] };
    });
    const currentPaths = stagedPaths(draft);
    await releasePaths([...stagedPaths(previousDraft)].filter(path => !currentPaths.has(path)));
  } catch (error) {
    await releasePaths(newPaths);
    throw error;
  }
}

export async function deleteFullPublishDraft(uid: string, id: string): Promise<void> {
  await draftWrites.get(`${uid}:${id}`)?.catch(() => undefined);
  let deleted: FullPublishDraft | undefined;
  await updateTauriStoreValue<FullDraftMap>('publish_drafts.json', 'fullDrafts', {}, (map) => {
    deleted = map[uid]?.find(item => item.id === id);
    return { ...map, [uid]: (map[uid] || []).filter(item => item.id !== id) };
  });
  await releasePaths(stagedPaths(deleted));
  stagedFilesByDraft.delete(`${uid}:${id}`);
}

export async function restoreFullPublishDraft(draft: FullPublishDraft, uid?: string): Promise<PublishDraftState> {
  // 任意媒体损坏时整体停止恢复，防止用户不知情地发布缺图草稿。
  const state = draft.state;
  const owner = uid ? `${uid}:${draft.id}` : undefined;
  const images: PublishImage[] = [];
  // Read and validate every file before creating previews or applying any draft fields.
  for (const image of state.images) images.push({ ...image,
    file: image.file ? await restoreFile(image.file, owner) : undefined,
    liveVideo: image.liveVideo ? await restoreFile(image.liveVideo, owner) : undefined,
  });
  const file = state.video ? await restoreFile(state.video.file, owner) : undefined;
  const cover = state.video ? await restoreFile(state.video.cover, owner) : undefined;
  for (const image of images) if (image.file && !image.preview) image.preview = await readFilePreview(image.file);
  return { ...state, images, video: state.video && file && cover ? {
    ...state.video, file, cover, coverPreview: state.video.coverPreview || await readFilePreview(cover), preview: URL.createObjectURL(file),
  } : undefined };
}

interface PublishDraft {
  text: string;
  updatedAt: number;
}

type PublishDraftMap = Record<string, PublishDraft>;

const STORE_FILE = 'publish_drafts.json';
const STORE_KEY = 'drafts';
const drafts: PublishDraftMap = {};
let readyPromise: Promise<void> | null = null;

function accountKey(userUid: string | number | null | undefined): string {
  return String(userUid || 'guest');
}

function loadDraftMap(value: unknown): PublishDraftMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: PublishDraftMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (item && typeof item === 'object' && typeof (item as PublishDraft).text === 'string') {
      result[key] = { text: (item as PublishDraft).text, updatedAt: Number((item as PublishDraft).updatedAt) || 0 };
    }
  }
  return result;
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = readTauriStoreValue<unknown>(STORE_FILE, STORE_KEY).then((value) => {
      Object.assign(drafts, loadDraftMap(value));
    }).catch((error) => {
      console.warn('加载发布动态草稿失败:', error);
    });
  }
  return readyPromise;
}

export async function loadPublishDraft(userUid: string | number | null | undefined): Promise<string> {
  await ensureReady();
  return drafts[accountKey(userUid)]?.text || '';
}

export async function savePublishDraft(userUid: string | number | null | undefined, text: string): Promise<void> {
  await ensureReady();
  const key = accountKey(userUid);
  if (!text.trim()) delete drafts[key];
  else drafts[key] = { text, updatedAt: Date.now() };
  await updateTauriStoreValue(STORE_FILE, STORE_KEY, {}, () => ({ ...drafts }));
}

export async function clearPublishDraft(userUid: string | number | null | undefined): Promise<void> {
  await savePublishDraft(userUid, '');
}
