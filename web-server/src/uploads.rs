//! Browser files are staged under opaque IDs, never interpreted as host paths.
use super::*;
use axum::extract::Multipart;
use std::{collections::HashMap, sync::Mutex as SyncMutex};
use tokio::{io::AsyncWriteExt, sync::{Semaphore, watch}};

pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STAGE_BYTES: u64 = 1024 * 1024 * 1024;
const STAGE_TTL_SECONDS: i64 = 7 * 24 * 3600;

pub struct ActiveUpload { token: String, cancel: watch::Sender<bool> }
pub struct UploadState {
    active: SyncMutex<HashMap<String, ActiveUpload>>,
    receiving: Semaphore,
    video: Semaphore,
}
impl Default for UploadState {
    fn default() -> Self { Self { active: SyncMutex::new(HashMap::new()), receiving: Semaphore::new(1), video: Semaphore::new(1) } }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageMeta { file_name: String, size: u64, created_at: i64, #[serde(default)] purpose: StagePurpose }
#[derive(Default, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum StagePurpose { #[default] Cdn, Draft }
#[derive(Deserialize)]
pub struct StageQuery { name: String, #[serde(default)] purpose: StagePurpose }
struct TemporaryStage { directory: PathBuf, keep: bool }
impl Drop for TemporaryStage {
    fn drop(&mut self) { if !self.keep { let _ = std::fs::remove_dir_all(&self.directory); } }
}
struct ActiveGuard<'a> { state: &'a UploadState, id: String }
impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) { if let Ok(mut active) = self.state.active.lock() { active.remove(&self.id); } }
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.len() != 64 || !token.bytes().all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase()) { return Err("暂存文件标识无效".into()); }
    Ok(())
}

pub fn validate_oss_upload_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "OSS 上传地址无效")?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https" || !host.ends_with(".aliyuncs.com") || !url.username().is_empty() || url.password().is_some() || url.port().is_some_and(|port| port != 443) || url.query().is_some() || url.fragment().is_some() || url.path().contains('\\') { return Err("OSS 上传地址不受信任".into()); }
    Ok(())
}
fn token_from_path(path: &str) -> Result<&str, String> {
    let token = path.strip_prefix("upload:").ok_or("仅支持浏览器暂存文件，不能读取服务器路径")?;
    validate_token(token)?;
    Ok(token)
}
fn stage_directory(state: &AppState, token: &str) -> Result<PathBuf, String> {
    validate_token(token)?;
    let root = state.data_dir.join("uploads");
    reject_symlink(&root)?;
    let directory = root.join(token);
    reject_symlink(&directory)?;
    Ok(directory)
}
fn stage_file(state: &AppState, token: &str) -> Result<(PathBuf, StageMeta), String> {
    let directory = stage_directory(state, token)?;
    let meta_path = directory.join("metadata.json");
    reject_symlink(&meta_path)?;
    let meta: StageMeta = serde_json::from_slice(&std::fs::read(meta_path).map_err(|_| "暂存文件不存在，请重新选择文件")?).map_err(|_| "暂存文件信息无效")?;
    safe_filename(&meta.file_name)?;
    if meta.size > MAX_FILE_BYTES || meta.purpose == StagePurpose::Cdn && chrono::Utc::now().timestamp() - meta.created_at > STAGE_TTL_SECONDS { return Err("暂存文件已过期，请重新选择文件".into()); }
    let body = directory.join("body");
    reject_symlink(&body)?;
    let path = body.join(&meta.file_name);
    reject_symlink(&path)?;
    let canonical = std::fs::canonicalize(&path).map_err(|_| "暂存文件不存在，请重新选择文件")?;
    if !canonical.starts_with(std::fs::canonicalize(&directory).map_err(|_| "暂存目录无效")?) || !canonical.is_file() || std::fs::metadata(&canonical).map_err(|_| "暂存文件无法读取")?.len() != meta.size { return Err("暂存文件无效".into()); }
    Ok((canonical, meta))
}
pub fn cleanup_and_usage(state: &AppState, startup: bool) -> Result<u64, String> {
    let root = state.data_dir.join("uploads");
    reject_symlink(&root)?;
    let active = state.uploads.active.lock().map_err(|_| "上传任务列表不可用")?;
    let mut bytes = 0;
    let mut count = 0;
    for entry in std::fs::read_dir(root).map_err(|_| "暂存目录不可读")? {
        let entry = entry.map_err(|_| "暂存目录不可读")?;
        let token = entry.file_name().to_string_lossy().to_string();
        if validate_token(&token).is_err() || !entry.file_type().map_err(|_| "暂存目录不可读")?.is_dir() { continue; }
        let meta = std::fs::read(entry.path().join("metadata.json")).ok().and_then(|bytes| serde_json::from_slice::<StageMeta>(&bytes).ok());
        if active.values().any(|item| item.token == token) { bytes += meta.map(|item| item.size).unwrap_or(MAX_FILE_BYTES); count += 1; continue; }
        if meta.as_ref().is_some_and(|item| item.purpose == StagePurpose::Cdn && chrono::Utc::now().timestamp() - item.created_at > STAGE_TTL_SECONDS) || startup && meta.is_none() {
            let _ = std::fs::remove_dir_all(entry.path());
        } else { bytes += meta.map(|item| item.size).unwrap_or(MAX_FILE_BYTES); count += 1; }
    }
    if count >= 128 && !startup { return Err("暂存文件过多，请删除不需要的草稿或上传历史".into()); }
    Ok(bytes)
}
fn temporary_stage(state: &AppState) -> Result<(String, TemporaryStage), String> {
    reject_symlink(&state.data_dir.join("uploads"))?;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "系统随机数不可用")?;
    let token = hex::encode(bytes);
    let directory = stage_directory(state, &token)?;
    std::fs::create_dir(&directory).map_err(|_| "不能创建暂存目录")?;
    let guard = TemporaryStage { directory, keep: false };
    std::fs::create_dir(guard.directory.join("body")).map_err(|_| "不能创建暂存目录")?;
    Ok((token, guard))
}

pub async fn stage(State(state): State<Arc<AppState>>, Query(query): Query<StageQuery>, headers: HeaderMap, request: Request) -> ApiResult<Json<Value>> {
    let name = safe_filename(&query.name)?;
    if headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).map(|value| value.split(';').next().unwrap_or("").trim()) != Some("application/octet-stream") { return Err("暂存上传需使用 application/octet-stream".into()); }
    let _permit = state.uploads.receiving.try_acquire().map_err(|_| ApiError(StatusCode::CONFLICT, "另一个文件正在暂存，请等待完成".into()))?;
    let usage = cleanup_and_usage(&state, false)?;
    if usage >= MAX_STAGE_BYTES { return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "暂存文件总量超过 1 GB，请清理上传历史".into())); }
    if headers.get(header::CONTENT_LENGTH).and_then(|value| value.to_str().ok()).and_then(|value| value.parse::<u64>().ok()).is_some_and(|size| size > MAX_FILE_BYTES || size.saturating_add(usage) > MAX_STAGE_BYTES) { return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "文件超过暂存大小限制".into())); }
    let (token, mut guard) = temporary_stage(&state)?;
    let path = guard.directory.join("body").join(&name);
    let mut file = tokio::fs::OpenOptions::new().create_new(true).write(true).open(path).await.map_err(|_| "不能创建暂存文件")?;
    let mut stream = request.into_body().into_data_stream();
    let mut size = 0u64;
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(60), stream.next()).await.map_err(|_| "暂存上传超时")? {
        let chunk = chunk.map_err(|_| "暂存上传被中断")?;
        size = size.saturating_add(chunk.len() as u64);
        if size > MAX_FILE_BYTES || size.saturating_add(usage) > MAX_STAGE_BYTES { return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "文件超过暂存大小限制".into())); }
        file.write_all(&chunk).await.map_err(|_| "不能保存暂存文件")?;
    }
    if size == 0 { return Err("不能上传空文件".into()); }
    file.flush().await.map_err(|_| "不能保存暂存文件")?;
    drop(file);
    let meta = StageMeta { file_name: name.clone(), size, created_at: chrono::Utc::now().timestamp(), purpose: query.purpose };
    write_json_atomic(&guard.directory.join("metadata.json"), &serde_json::to_value(meta).map_err(|_| "暂存信息无效")?).await?;
    guard.keep = true;
    Ok(Json(json!({"filePath": format!("upload:{token}"), "fileName":name, "size":size})))
}

pub async fn read(State(state): State<Arc<AppState>>, HttpPath(token): HttpPath<String>, request: Request) -> ApiResult<Response> {
    let (path, _) = stage_file(&state, &token)?;
    use tower::ServiceExt;
    let mut response = ServeFile::new(path).oneshot(request).await.map_err(|_| "暂存文件不能读取")?.into_response();
    response.headers_mut().insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response.headers_mut().insert("content-security-policy", HeaderValue::from_static("sandbox; default-src 'none'"));
    response.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    Ok(response)
}

pub async fn release(State(state): State<Arc<AppState>>, HttpPath(token): HttpPath<String>) -> ApiResult<Json<Value>> {
    let directory = stage_directory(&state, &token)?;
    // A store PUT may succeed while its response is lost. Never erase an
    // attachment that the durable draft still owns; serialize with store writes.
    let _stores = state.stores_gate.lock().await;
    let draft_path = state.data_dir.join("settings/publish_drafts.json");
    reject_symlink(&draft_path)?;
    let reference = format!("upload:{token}");
    match std::fs::read(draft_path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "草稿存储损坏，暂不能删除附件")?;
            if draft_references(&value, &reference) { return Err(ApiError(StatusCode::CONFLICT, "附件仍被已保存草稿使用，不能删除".into())); }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err("不能读取草稿引用，暂不能删除附件".into()),
    }
    let active = state.uploads.active.lock().map_err(|_| "上传任务列表不可用")?;
    if active.values().any(|item| item.token == token) { return Err(ApiError(StatusCode::CONFLICT, "文件仍在上传，不能删除暂存".into())); }
    match std::fs::remove_dir_all(directory) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(_) => return Err("不能删除暂存文件".into()) }
    Ok(Json(json!({"released":true})))
}

fn draft_references(value: &Value, reference: &str) -> bool {
    match value {
        Value::Object(values) => values.get("stagedPath").and_then(Value::as_str) == Some(reference) || values.values().any(|value| draft_references(value, reference)),
        Value::Array(values) => values.iter().any(|value| draft_references(value, reference)),
        _ => false,
    }
}

async fn snapshot(state: &AppState) -> Result<CoolapkClient, String> {
    let _gate = tokio::time::timeout(Duration::from_secs(15), state.account_gate.read()).await.map_err(|_| "账户正在切换，请稍后重试")?;
    state.client.web_snapshot()
}
async fn upload_or_cancel<F: std::future::Future>(future: F, receiver: &mut watch::Receiver<bool>) -> Result<Option<F::Output>, String> {
    tokio::select! {
        _ = receiver.changed() => Ok(None),
        result = tokio::time::timeout(Duration::from_secs(3600), future) => result.map(Some).map_err(|_| "上传请求超时，结果未知，请先确认是否已完成".to_string()),
    }
}
pub async fn cancel(state: &AppState, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "taskId", "task_id", false)?;
    let active = state.uploads.active.lock().map_err(|_| "上传任务列表不可用")?;
    let Some(task) = active.get(&id) else { return Ok(json!(false)); };
    task.cancel.send_replace(true);
    Ok(json!(true))
}
pub async fn start(state: &AppState, args: &Value) -> Result<Value, String> {
    let id: String = arg(args, "taskId", "task_id", false)?;
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) { return Err("上传任务 ID 无效".into()); }
    let attempt: u32 = arg(args, "attempt", "attempt", false)?;
    if attempt == 0 { return Err("上传轮次无效".into()); }
    let file_path: String = arg(args, "filePath", "file_path", false)?;
    let token = token_from_path(&file_path)?.to_string();
    let (sender, mut receiver) = watch::channel(false);
    {
        let mut active = state.uploads.active.lock().map_err(|_| "上传任务列表不可用")?;
        if active.contains_key(&id) || active.values().any(|item| item.token == token) { return Err("上传任务或文件已在处理".into()); }
        if active.len() >= 2 { return Err("同时上传的任务过多".into()); }
        active.insert(id.clone(), ActiveUpload { token: token.clone(), cancel: sender });
    }
    let _guard = ActiveGuard { state: &state.uploads, id: id.clone() };
    let (path, meta) = stage_file(state, &token)?;
    if meta.purpose != StagePurpose::Cdn { return Err("草稿附件不能作为 CDN 上传任务使用，请重新选择文件".into()); }
    let client = snapshot(state).await?;
    if client.get_user_cookie().is_none() { return Err("请先登录酷安账号再上传文件".into()); }
    let emit = |status: &str, uploaded: u64, url: Option<&str>, error: Option<&str>| { let _ = state.emit("cdn-upload-progress", json!({"taskId":id,"attempt":attempt,"fileName":meta.file_name,"status":status,"uploaded":uploaded,"total":meta.size,"speed":0,"url":url,"error":error})); };
    emit("preparing", 0, None, None);
    let events = state.events.clone();
    let progress_id = id.clone();
    let progress_name = meta.file_name.clone();
    let sample = Arc::new(SyncMutex::new((std::time::Instant::now(), 0u64)));
    let upload = client.upload_file_with_progress(&path, move |uploaded, total| {
        let Ok(mut previous) = sample.lock() else { return; };
        let elapsed = previous.0.elapsed();
        if elapsed < Duration::from_millis(200) && uploaded < total.saturating_sub(1) { return; }
        let speed = (uploaded.saturating_sub(previous.1) as f64 / elapsed.as_secs_f64().max(0.001)) as u64;
        *previous = (std::time::Instant::now(), uploaded);
        let _ = events.send(("cdn-upload-progress".into(), json!({"taskId":progress_id,"attempt":attempt,"fileName":progress_name,"status":"uploading","uploaded":uploaded,"total":total,"speed":speed})));
    });
    let result = match upload_or_cancel(upload, &mut receiver).await? {
        Some(result) => result,
        None => { emit("cancelled", 0, None, None); return Ok(json!({"code":499,"status":"cancelled"})); },
    };
    match result {
        Ok(value) => { emit("completed", meta.size, value.get("data").and_then(Value::as_str), None); Ok(value) },
        Err(error) => { emit("failed", 0, None, Some(&error)); Err(error) },
    }
}

async fn multipart_upload(state: Arc<AppState>, mut multipart: Multipart, video: bool) -> ApiResult<Json<Value>> {
    let _permit = state.uploads.video.try_acquire().map_err(|_| ApiError(StatusCode::CONFLICT, "另一个媒体正在上传，请等待完成".into()))?;
    let (_, guard) = temporary_stage(&state)?;
    let mut fields = HashMap::new();
    let mut files = HashMap::new();
    while let Some(mut field) = multipart.next_field().await.map_err(|_| "上传表单无效")? {
        let key = field.name().ok_or("上传字段缺少名称")?.to_string();
        if fields.contains_key(&key) || files.contains_key(&key) { return Err("上传字段重复".into()); }
        let binary = if video { matches!(key.as_str(), "video" | "cover") } else { matches!(key.as_str(), "image" | "liveVideo") };
        if binary {
            let name = safe_filename(field.file_name().ok_or("上传文件缺少名称")?)?;
            let content_type = field.content_type().unwrap_or("application/octet-stream").to_string();
            let path = guard.directory.join("body").join(&key);
            let limit = if key == "video" || key == "liveVideo" { MAX_FILE_BYTES } else { MAX_IMAGE_BYTES };
            let mut output = tokio::fs::OpenOptions::new().create_new(true).write(true).open(&path).await.map_err(|_| "不能创建上传文件")?;
            let mut size = 0u64;
            while let Some(chunk) = tokio::time::timeout(Duration::from_secs(60), field.chunk()).await.map_err(|_| "上传文件超时")?.map_err(|_| "上传文件被中断")? {
                size = size.saturating_add(chunk.len() as u64);
                if size > limit { return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "媒体文件超过大小限制".into())); }
                output.write_all(&chunk).await.map_err(|_| "不能保存上传文件")?;
            }
            output.flush().await.map_err(|_| "不能保存上传文件")?;
            files.insert(key, (path, name, content_type));
        } else {
            if !if video { key == "duration" } else { matches!(key.as_str(), "dir" | "hdr" | "toUid") } { return Err("上传字段不受支持".into()); }
            let mut bytes = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(|_| "上传参数被中断")? { if bytes.len() + chunk.len() > 1024 { return Err("上传参数过长".into()); } bytes.extend_from_slice(&chunk); }
            fields.insert(key, String::from_utf8(bytes).map_err(|_| "上传参数无效")?);
        }
    }
    // Validate all browser-controlled fields before the first upstream request.
    let read_file = |key: &str| -> Result<Vec<u8>, String> { let item = files.get(key).ok_or("上传文件缺失")?; std::fs::read(&item.0).map_err(|_| "不能读取上传文件".into()) };
    let result = if video {
        let duration: u64 = fields.get("duration").ok_or("视频时长缺失")?.parse().map_err(|_| "视频时长无效")?;
        let bytes = read_file("video")?;
        let cover = read_file("cover")?;
        if bytes.len() < 12 || &bytes[4..8] != b"ftyp" || cover.len() < 3 || cover[..3] != [0xff, 0xd8, 0xff] || duration == 0 { return Err("视频或封面无效".into()); }
        let client = snapshot(&state).await?;
        tokio::time::timeout(Duration::from_secs(1800), client.upload_publish_video(&bytes, &files["video"].1, &cover, duration)).await.map_err(|_| "视频上传请求超时，结果未知，请先确认是否已完成")??
    } else {
        let bytes = read_file("image")?;
        if bytes.is_empty() || !files["image"].2.starts_with("image/") { return Err("图片无效".into()); }
        let dir = fields.get("dir").map(String::as_str).unwrap_or("feed");
        if !["feed", "avatar", "message", "album"].contains(&dir) { return Err("图片上传目录无效".into()); }
        let hdr: u32 = fields.get("hdr").map(String::as_str).unwrap_or("0").parse().map_err(|_| "HDR 参数无效")?;
        let live = if files.contains_key("liveVideo") { Some(read_file("liveVideo")?) } else { None };
        let client = snapshot(&state).await?;
        tokio::time::timeout(Duration::from_secs(1800), client.upload_image_with_live(&bytes, &files["image"].1, &files["image"].2, dir, fields.get("toUid").map(String::as_str), live.as_deref(), hdr)).await.map_err(|_| "图片上传请求超时，结果未知，请先确认是否已完成")??
    };
    Ok(Json(redact_secrets(result)))
}
async fn publish_video(State(state): State<Arc<AppState>>, multipart: Multipart) -> ApiResult<Json<Value>> { multipart_upload(state, multipart, true).await }
async fn image(State(state): State<Arc<AppState>>, multipart: Multipart) -> ApiResult<Json<Value>> { multipart_upload(state, multipart, false).await }
pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/uploads/stage", post(stage))
        .route("/uploads/stage/{token}", get(read).delete(release))
        .route("/uploads/publish-video", post(publish_video))
        .route("/uploads/image", post(image))
        .layer(DefaultBodyLimit::max((MAX_FILE_BYTES + MAX_IMAGE_BYTES + 64 * 1024) as usize))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelling_drops_the_active_upload_future() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Signal(Arc<AtomicBool>);
        impl Drop for Signal { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }
        let dropped = Arc::new(AtomicBool::new(false));
        let signal = Signal(dropped.clone());
        let future = async move { let _signal = signal; std::future::pending::<()>().await; };
        let (sender, mut receiver) = watch::channel(false);
        let pending = tokio::spawn(async move { upload_or_cancel(future, &mut receiver).await });
        tokio::task::yield_now().await;
        sender.send_replace(true);
        assert!(pending.await.unwrap().unwrap().is_none());
        assert!(dropped.load(Ordering::SeqCst));
    }
}
