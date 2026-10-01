import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { isTauri as nativeIsTauri } from '@tauri-apps/api/core';

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  push: vi.fn(),
  resolve: vi.fn(() => ({ matched: [] as unknown[] })),
}));
vi.mock('../../router', () => ({ router: { push: mocks.push, resolve: mocks.resolve } }));
vi.mock('../../api/coolapk', () => ({ CoolapkTauriAPI: { openUrl: mocks.openUrl } }));
vi.mock('../../stores/settings', () => ({ useSettingsStore: () => ({ settings: { externalLinkMode: 'internal' } }) }));

import { handleAnchorClick, handleGlobalAnchorClick } from '../anchorClick';
import { apiRequest } from '../runtime';
import FilesPage from '../../pages/FilesPage.vue';

describe('native browser attachment clicks', () => {
  let globalListener: (event: Event) => void;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nativeIsTauri).mockReturnValue(false);
    mocks.resolve.mockReturnValue({ matched: [] });
    globalListener = handleGlobalAnchorClick;
    document.addEventListener('click', globalListener);
  });
  afterEach(() => { document.removeEventListener('click', globalListener); });

  function click(anchor: HTMLAnchorElement, richText = false) {
    let preventedBeforeBrowser = false;
    const stopNavigation = (event: Event) => {
      preventedBeforeBrowser = event.defaultPrevented;
      // jsdom cannot download. Observe the handlers first, then suppress its navigation.
      event.preventDefault();
    };
    if (richText) anchor.addEventListener('click', handleAnchorClick);
    document.addEventListener('click', stopNavigation);
    anchor.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    document.removeEventListener('click', stopNavigation);
    if (richText) anchor.removeEventListener('click', handleAnchorClick);
    return preventedBeforeBrowser;
  }
  function link(href: string, download = true) {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.innerHTML = '<span>Download fixture</span>';
    if (download) anchor.download = 'fixture.png';
    document.body.appendChild(anchor);
    return anchor;
  }

  it.each([false, true])('keeps a FilesPage relative attachment native with rich-text handler=%s', async (richText) => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ files: [{ name: 'fixture.png', path: 'exports/fixture.png', url: '/api/files/exports/fixture.png', size: 12 }] });
    const wrapper = mount(FilesPage, { attachTo: document.body, global: { stubs: { AppButton: true } } });
    await flushPromises();
    const anchor = wrapper.get('a.file-row').element as HTMLAnchorElement;
    expect(anchor.getAttribute('href')).toBe('/api/files/exports/fixture.png');
    expect(anchor.download).toBe('fixture.png');
    expect(click(anchor, richText)).toBe(false);
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each([false, true])('does not redirect a same-origin absolute attachment with rich-text handler=%s', (richText) => {
    expect(click(link(`${window.location.origin}/api/files/exports/fixture.png`), richText)).toBe(false);
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it.each([
    `blob:${window.location.origin}/synthetic-download`,
    'data:image/png;base64,iVBORw0KGgo=',
    'data:application/json,%7B%22synthetic%22%3Atrue%7D',
  ])('lets the browser download %s without app routing', (href) => {
    expect(click(link(href), true)).toBe(false);
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it.each([`blob:${window.location.origin}/synthetic-download`, 'data:text/plain,synthetic'])('still blocks %s without a download attribute', (href) => {
    expect(click(link(href, false))).toBe(true);
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('honors an explicit local download before interpreting a Coolapk content route', () => {
    expect(click(link('/feed/12345'), true)).toBe(false);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it.each([false, true])('does not let an external HTTPS download bypass link preferences, rich-text=%s', (richText) => {
    expect(click(link('https://example.com/fixture.png'), richText)).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/fixture.png', 'internal');
  });

  it.each([false, true])('keeps protocol-relative external download URLs inside the link policy, rich-text=%s', (richText) => {
    const anchor = link('//example.com/fixture.png');
    expect(click(anchor, richText)).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith(anchor.href, 'internal');
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' java\nscript:alert(1)', 'file:///etc/passwd', 'vbscript:msgbox(1)', 'blob:https://example.com/object', 'data:javascript:alert(1)'])('blocks executable/invalid download URL %s', (href) => {
    expect(click(link(href), true)).toBe(true);
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('preserves ordinary external links and already-handled router clicks', () => {
    expect(click(link('https://example.com/article', false))).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/article', 'internal');
    mocks.openUrl.mockClear();
    const anchor = link('https://example.com/article', false);
    anchor.addEventListener('click', (event) => event.preventDefault());
    expect(click(anchor)).toBe(true);
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps ordinary protocol-relative external links inside the upstream policy, rich-text=%s', (richText) => {
    const anchor = link('//example.com/article', false);
    expect(click(anchor, richText)).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith(richText ? '//example.com/article' : anchor.href, 'internal');
  });

  it('keeps normal Coolapk content routing when there is no download attribute', () => {
    expect(click(link('/feed/12345', false), true)).toBe(true);
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/feed/12345');
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('keeps native Tauri absolute-link and unsupported-scheme handling', () => {
    vi.mocked(nativeIsTauri).mockReturnValue(true);
    const absolute = `${window.location.origin}/api/files/exports/fixture.png`;
    expect(click(link(absolute))).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith(absolute, 'internal');
    mocks.openUrl.mockClear();
    expect(click(link(`blob:${window.location.origin}/synthetic-download`))).toBe(true);
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('keeps native Tauri rich-text relative-link routing', () => {
    vi.mocked(nativeIsTauri).mockReturnValue(true);
    expect(click(link('/api/files/exports/fixture.png'), true)).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith('https://www.coolapk.com/api/files/exports/fixture.png');
  });
});
