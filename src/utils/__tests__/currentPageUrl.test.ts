import { describe, expect, it } from 'vitest';
import { getOfficialCoolapkPageUrl } from '../currentPageUrl';

describe('当前页面的官方酷安内容链接', () => {
  it.each([
    ['/feed/123', 'https://www.coolapk.com/feed/123'],
    ['/question/456', 'https://www.coolapk.com/feed/456'],
    ['/goods/lists/789', 'https://www.coolapk.com/feed/789'],
    ['/goods/ranking/790', 'https://www.coolapk.com/feed/790'],
    ['/user/12345', 'https://www.coolapk.com/u/12345'],
    ['/app/com.coolapk.market', 'https://www.coolapk.com/apk/com.coolapk.market'],
    ['/collection/321', 'https://www.coolapk.com/collection/321'],
    ['/live/432', 'https://www.coolapk.com/live/432'],
  ])('将 %s 转换为对应内容，而不是本地页面', (path, expected) => {
    expect(getOfficialCoolapkPageUrl({ path })).toBe(expected);
  });

  it('使用路由已经解码的实体参数，并且只编码一次话题名称', () => {
    expect(getOfficialCoolapkPageUrl({ path: '/topic/Android%2016', params: { tag: 'Android 16' } }))
      .toBe('https://www.coolapk.com/t/Android%2016');
    expect(getOfficialCoolapkPageUrl({ path: '/topic/%E9%85%B7%E5%AE%89', params: { tag: '酷安' } }))
      .toBe('https://www.coolapk.com/t/%E9%85%B7%E5%AE%89');
    expect(getOfficialCoolapkPageUrl({ path: '/app/com.example%2Eapp' }))
      .toBe('https://www.coolapk.com/apk/com.example.app');
  });

  it('收藏列表仅在明确打开收藏单时提供该收藏单链接', () => {
    expect(getOfficialCoolapkPageUrl({ path: '/favorites', query: { collectionId: '321', collectionTitle: '收藏' } }))
      .toBe('https://www.coolapk.com/collection/321');
    expect(getOfficialCoolapkPageUrl({ path: '/favorites' })).toBeNull();
  });

  it.each(['/', '/search', '/settings/about', '/messages', '/files', '/downloads', '/history', '/product/123', '/dyh/123', '/album/123', '/user/123/relations/follow', '/page'])
  ('没有可靠分享目标的 %s 不提供页面地址', (path) => {
    expect(getOfficialCoolapkPageUrl({ path, query: { url: '/feed/123' } })).toBeNull();
  });

  it.each(['/feed/not-an-id', '/feed/0', '/user/0', '/user/username', '/collection/../../etc', '/app/list', '/topic/%E0%A4%A'])
  ('不把无效实体 %s 拼成官方内容', (path) => {
    expect(getOfficialCoolapkPageUrl({ path })).toBeNull();
  });

  it('拒绝含义不明确的多个 ID 和空参数，不从当前 path 补造目标', () => {
    expect(getOfficialCoolapkPageUrl({ path: '/feed/123', params: { feedId: '' } })).toBeNull();
    expect(getOfficialCoolapkPageUrl({ path: '/favorites', query: { collectionId: ['123', '456'] } })).toBeNull();
  });

  it('外部阅读页仅使用显式官方网页地址，并保留该网页的查询参数', () => {
    expect(getOfficialCoolapkPageUrl({ path: '/external', query: { url: 'https://m.coolapk.com/product/detail?id=123' } }))
      .toBe('https://m.coolapk.com/product/detail?id=123');
  });

  it.each([
    '/feed/123', '#/feed/123', 'tauri://localhost/feed/123', 'http://tauri.localhost/feed/123',
    'https://coolapk.example.com:88/#/feed/123', 'https://www.coolapk.com.evil.test/feed/123',
    'https://user@www.coolapk.com/feed/123', 'https://www.coolapk.com:88/feed/123', 'https://www.coolapk.com/#/feed/123',
  ])('不会把本地、伪造或非官方来源 %s 作为内容 URL', (url) => {
    expect(getOfficialCoolapkPageUrl({ path: '/external', query: { url } })).toBeNull();
  });
});
