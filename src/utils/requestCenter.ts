import { reactive, readonly } from 'vue';

export type RequestKind = 'feed' | 'comment' | 'default';

export interface RequestPolicy {
  retry?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  kind?: RequestKind;
  operation?: 'read' | 'write';
}

export const NATIVE_REQUEST_TIMEOUT_MS = 15_000;
export const WEB_REQUEST_TIMEOUT_MS = 90_000;
export const WRITE_RESULT_UNKNOWN = '结果未知，请先确认是否已完成，请勿重复发送';

// Keep this explicit: a new command must be reviewed before it can be retried.
const READ_ONLY_COMMANDS = new Set(`
get_index_v8_feeds get_index_v8_feeds_paged get_index_v8_entities_paged get_tab_config
get_discovery_config get_discovery_page_data get_live_detail get_search_suggestions
get_topic_detail_v7 get_product_detail get_product_feeds get_product_config
get_product_brand_list get_product_category_list get_product_list get_product_brand_products
get_secondhand_brand_list get_secondhand_product_list get_product_media_list get_product_wish_list
get_product_buy_list get_my_product_list get_product_rating_chart get_product_subtab_feeds
get_product_rating_list get_apk_rating_user_list get_dyh_detail get_dyh_list get_dyh_feeds
get_event_list get_event_detail get_dyh_follow_list get_dyh_subscribe_list get_dyh_editor_list
get_user_product_albums get_goods_list_items get_node_feeds get_apk_feeds get_hot_feeds
get_rank_feeds get_latest_feeds get_digest_feeds get_cool_picture_rank get_board_feeds
get_secondhand_feeds get_hot_topics get_favorite_list get_feed_collection_status get_collection_list
get_collection_item_list get_collection_detail get_feed_forward_list get_feed_like_list
get_feed_change_history search_tags get_device_feed_list get_question_answers get_vote_comments
get_hit_history get_recent_history get_spam_feed_list get_hidden_replies get_followed_topics
search_users get_search_suggestions_app search_feed_topics search_publish_topics get_product_versions get_product_detail_by_name
get_load_config get_home_tab_config get_feed_detail get_public_feed_detail get_editable_feed
resolve_video_url resolve_live_photo_video get_live_photo_video_header get_reply_detail
get_feed_replies get_sub_replies get_hot_replies search_all search_by_type get_hot_searches
search_feeds get_user_space get_public_user_space get_user_profile get_public_user_profile
get_user_remark_list get_user_qr_image get_user_follow_nodes get_user_forum_follow_list
get_user_feeds get_user_like_list get_user_tab_data get_topic_detail get_topic_feeds
get_topic_tab_data get_topic_hub_data get_app_detail get_apk_comments get_notification_count
get_notifications list_messages get_recent_chat_users list_chat_history get_black_list
get_ignore_list get_limit_list get_apk_url get_apk_qr get_following_feeds get_follow_user_list
get_fans_user_list get_device_info list_accounts get_game_list search_apks search_games
get_app_list get_album_list search_albums get_album_detail get_user_album_list get_album_replies
get_headline_feeds get_update_list get_editor_choice_feeds get_apk_discoverers get_apk_recommend_list
get_apk_related_apps get_apk_gift_list get_download_version_list get_picture_list
get_user_rating_list search_apks_by_developer search_apks_by_tag get_goods_search_hot_words
search_goods get_goods_detail get_goods_list_types get_goods_list get_goods_store_items
get_product_albums get_my_goods_feeds check_login_status check_login_info get_user_cookie
fetch_external_page get_image_data_url get_cache_info get_download_directory get_diagnostic_logs
get_diagnostic_verbose get_platform_info get_update_distribution is_update_package_available
`.trim().split(/\s+/));

export function isReadOnlyCommand(command: string, args?: Record<string, unknown>): boolean {
  // loadConfig's reSet=1 resets account configuration despite the get_ name.
  const reset = args?.reset;
  const resetsHomeConfig = command === 'get_home_tab_config' && (reset === true || reset === 1 || reset === '1' || reset === 'true');
  return READ_ONLY_COMMANDS.has(command) && !resetsHomeConfig;
}

const requestState = reactive({
  isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  lastError: '',
  lastErrorAt: 0,
  lastSuccessAt: 0,
});

export const requestCenterState = readonly(requestState);

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { requestState.isOnline = true; });
  window.addEventListener('offline', () => { requestState.isOnline = false; });
}

function getErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message || '');
  return String(error || '请求失败');
}

export function shouldRetryRequest(error: unknown): boolean {
  const message = getErrorText(error).toLowerCase();
  return /timeout|timed out|aborted|network|fetch|连接|网络|超时|502|503|504|429|temporar|暂时/.test(message);
}

export function explainUncertainWrite(error: unknown): Error {
  const message = getErrorText(error);
  if (message.includes(WRITE_RESULT_UNKNOWN)) return error instanceof Error ? error : new Error(message);
  // These backend transport/body failures can arrive after the upstream write.
  // Keep them separate from read retry rules: malformed reads must not retry.
  const uncertain = shouldRetryRequest(error) || /abort|取消|返回格式不正确|invalid response|error sending request for url|failed to read Coolapk response|invalid Coolapk JSON response|(?:http\s+|服务请求失败[（(])500\b/i.test(message);
  return uncertain ? new Error(`${message}；${WRITE_RESULT_UNKNOWN}`) : error instanceof Error ? error : new Error(message);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

class RequestDeadlineError extends Error {}

function withTimeout<T>(task: Promise<T>, controller: AbortController, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new RequestDeadlineError(`${label}请求超时`));
      controller.abort();
    }, timeoutMs);
    task.then((value) => { window.clearTimeout(timer); resolve(value); }, (error) => { window.clearTimeout(timer); reject(error); });
  });
}

export async function requestWithPolicy<T>(label: string, task: (signal: AbortSignal) => Promise<T>, policy: RequestPolicy = {}): Promise<T> {
  const retry = policy.operation !== 'write' && (policy.retry ?? false);
  const maxAttempts = retry ? Math.max(1, policy.maxAttempts ?? 3) : 1;
  const timeoutMs = policy.timeoutMs ?? NATIVE_REQUEST_TIMEOUT_MS;
  const retryDelayMs = policy.retryDelayMs ?? 350;
  requestState.pending += 1;
  try {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const controller = new AbortController();
        const request = Promise.resolve().then(() => task(controller.signal));
        // A long-running native command (for example a file upload) can opt out of
        // the UI timeout. Timing out this wrapper does not cancel the native future.
        const result = timeoutMs === 0 ? await request : await withTimeout(request, controller, timeoutMs, label);
        requestState.lastError = '';
        requestState.lastSuccessAt = Date.now();
        return result;
      } catch (error) {
        lastError = policy.operation === 'write' ? explainUncertainWrite(error) : error;
        requestState.lastError = getErrorText(lastError);
        requestState.lastErrorAt = Date.now();
        // A deadline only ends our wait. The task (or an upstream write) may
        // still finish, so never overlap it with another automatic attempt.
        if (error instanceof RequestDeadlineError || attempt >= maxAttempts || !shouldRetryRequest(error)) throw lastError;
        await wait(retryDelayMs * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(getErrorText(lastError));
  } finally {
    requestState.pending = Math.max(0, requestState.pending - 1);
  }
}
