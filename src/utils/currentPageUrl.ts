type PageRoute = {
  path?: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

const COOLAPK_ORIGIN = 'https://www.coolapk.com';

function singleValue(value: unknown): string | null {
  if (Array.isArray(value)) return value.length === 1 ? singleValue(value[0]) : null;
  return typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function routeSegment(route: PageRoute, name: string, rawSegment: string): string | null {
  if (Object.prototype.hasOwnProperty.call(route.params || {}, name)) return singleValue(route.params?.[name]);
  try {
    return singleValue(decodeURIComponent(rawSegment));
  } catch {
    return null;
  }
}

function numericContentUrl(kind: 'feed' | 'u' | 'collection', id: string | null): string | null {
  return id && /^\d+$/.test(id) && !/^0+$/.test(id) ? `${COOLAPK_ORIGIN}/${kind}/${id}` : null;
}

/**
 * Only reverse routes with a known Coolapk share target. Local workspace pages
 * have no equivalent share URL and must not fall back to the deployment URL.
 */
export function getOfficialCoolapkPageUrl(route: PageRoute): string | null {
  const path = route.path || '';
  const feed = path.match(/^\/feed\/([^/]+)$/);
  if (feed) return numericContentUrl('feed', routeSegment(route, 'feedId', feed[1]));

  // These detail pages load the same feed entity through getFeedDetail.
  const question = path.match(/^\/question\/([^/]+)$/);
  if (question) return numericContentUrl('feed', routeSegment(route, 'questionId', question[1]));
  const goodsFeed = path.match(/^\/goods\/(?:lists|ranking)\/([^/]+)$/);
  if (goodsFeed) return numericContentUrl('feed', routeSegment(route, 'feedId', goodsFeed[1]));

  const user = path.match(/^\/user\/([^/]+)$/);
  if (user) return numericContentUrl('u', routeSegment(route, 'uid', user[1]));

  const topic = path.match(/^\/topic\/([^/]+)$/);
  if (topic) {
    const tag = routeSegment(route, 'tag', topic[1]);
    return tag ? `${COOLAPK_ORIGIN}/t/${encodeURIComponent(tag)}` : null;
  }

  const app = path.match(/^\/app\/([^/]+)$/);
  if (app) {
    const packageName = routeSegment(route, 'packageName', app[1]);
    return packageName && /^[a-z_][\w]*(?:\.[a-z_][\w]*)+$/i.test(packageName)
      ? `${COOLAPK_ORIGIN}/apk/${encodeURIComponent(packageName)}` : null;
  }

  const collection = path.match(/^\/collection\/([^/]+)$/);
  if (collection) return numericContentUrl('collection', routeSegment(route, 'collectionId', collection[1]));
  if (path === '/favorites') return numericContentUrl('collection', singleValue(route.query?.collectionId));

  // The live page already uses this official target in getLiveOpenUrl.
  const live = path.match(/^\/live\/([^/]+)$/);
  if (live) {
    const id = routeSegment(route, 'liveId', live[1]);
    return id ? `${COOLAPK_ORIGIN}/live/${encodeURIComponent(id)}` : null;
  }

  if (path === '/external') {
    const explicit = singleValue(route.query?.url);
    if (!explicit) return null;
    try {
      // This page provides its actual source URL. Do not resolve relative URLs
      // against either the current deployment or the Coolapk homepage.
      const url = new URL(explicit);
      if (!['http:', 'https:'].includes(url.protocol)
        || !/^(?:www\.|m\.)?coolapk\.com$/i.test(url.hostname)
        || url.username || url.password || url.port
        || url.hash || url.pathname === '/') return null;
      return url.href;
    } catch {
      return null;
    }
  }

  return null;
}
