import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppContextMenu from '../AppContextMenu.vue';

const mocks = vi.hoisted(() => ({
  route: { path: '/', fullPath: '/', params: {} as Record<string, string>, query: {} as Record<string, string> },
  writeText: vi.fn().mockResolvedValue(undefined),
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), go: vi.fn() }),
}));
vi.mock('../../../api/coolapk', () => ({
  CoolapkTauriAPI: { openUrl: mocks.openUrl, saveImage: vi.fn() },
}));

describe('全局右键菜单中的当前官方页面链接', () => {
  let wrapper: VueWrapper | undefined;
  let target: HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.route, { path: '/', fullPath: '/', params: {}, query: {} });
    Object.assign(navigator, { clipboard: { writeText: mocks.writeText } });
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' } as Selection);
    wrapper = mount(AppContextMenu, { attachTo: document.body });
    target = document.createElement('div');
    target.textContent = '页面空白区域';
    document.body.appendChild(target);
  });

  afterEach(() => {
    wrapper?.unmount();
    target.remove();
    vi.restoreAllMocks();
  });

  async function openMenu(element = target) {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));
    await wrapper!.vm.$nextTick();
  }

  function action(label: string): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>('.context-menu-item')).find(item => item.querySelector('span')?.textContent === label);
  }

  it('动态详情页复制和打开的都是官方动态链接，不含网页部署地址或 hash', async () => {
    Object.assign(mocks.route, { path: '/feed/123', fullPath: '/feed/123?rid=987', params: { feedId: '123' }, query: { rid: '987' } });
    await openMenu();
    action('复制当前页面地址')!.click();
    await flushPromises();
    expect(mocks.writeText).toHaveBeenCalledWith('https://www.coolapk.com/feed/123');
    expect(mocks.writeText).not.toHaveBeenCalledWith(window.location.href);

    await openMenu();
    action('使用系统浏览器打开当前页')!.click();
    await flushPromises();
    expect(mocks.openUrl).toHaveBeenCalledWith('https://www.coolapk.com/feed/123', 'system');
  });

  it('用户页使用官方 /u 链接，不直接拼接本地 /user 路由', async () => {
    Object.assign(mocks.route, { path: '/user/456', fullPath: '/user/456', params: { uid: '456' } });
    await openMenu();
    action('复制当前页面地址')!.click();
    await flushPromises();
    expect(mocks.writeText).toHaveBeenCalledWith('https://www.coolapk.com/u/456');
  });

  it.each(['/', '/search', '/settings/about', '/files', '/downloads', '/messages', '/product/123'])
  ('%s 没有官方对应 URL 时移除两个按钮，并保留其他全局操作', async (path) => {
    Object.assign(mocks.route, { path, fullPath: path, params: {}, query: {} });
    await openMenu();
    expect(action('复制当前页面地址')).toBeUndefined();
    expect(action('使用系统浏览器打开当前页')).toBeUndefined();
    expect(action('打开设置')).toBeDefined();
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('切换页面后重新根据当前内容建立菜单，不沿用上一个官方目标', async () => {
    Object.assign(mocks.route, { path: '/feed/123', params: { feedId: '123' } });
    await openMenu();
    expect(action('复制当前页面地址')).toBeDefined();
    Object.assign(mocks.route, { path: '/settings/appearance', params: {} });
    await openMenu();
    expect(action('复制当前页面地址')).toBeUndefined();
    expect(action('使用系统浏览器打开当前页')).toBeUndefined();
  });

  it('页面没有官方目标时，具体动态卡片仍能复制它自己的动态链接', async () => {
    Object.assign(mocks.route, { path: '/search', fullPath: '/search?q=test' });
    target.dataset.feedId = '678';
    target.dataset.feedText = '具体动态';
    await openMenu();
    expect(action('复制当前页面地址')).toBeUndefined();
    action('复制动态链接')!.click();
    await flushPromises();
    expect(mocks.writeText).toHaveBeenCalledWith('https://www.coolapk.com/feed/678');
  });

  it('原有具体链接菜单保留链接本身的复制和浏览器打开行为', async () => {
    target.innerHTML = '<a href="https://www.coolapk.com/feed/789">原始链接</a>';
    const link = target.querySelector('a')!;
    await openMenu(link);
    action('复制链接地址')!.click();
    await flushPromises();
    expect(mocks.writeText).toHaveBeenCalledWith('https://www.coolapk.com/feed/789');
    await openMenu(link);
    action('使用系统浏览器打开')!.click();
    await flushPromises();
    expect(mocks.openUrl).toHaveBeenCalledWith('https://www.coolapk.com/feed/789', 'system');
  });
});
