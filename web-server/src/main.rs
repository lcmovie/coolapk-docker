mod coolapk;
mod commands_generated;
mod dispatch_generated;
mod downloads_generated;
mod uploads;
#[path = "../../src-tauri/src/download_manager.rs"]
mod download_manager;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path as HttpPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response, Sse, sse::{Event, KeepAlive}},
    routing::{get, post}, Json, Router,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use coolapk::client::{CoolapkClient, DeviceProfile};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{convert::Infallible, path::{Component, Path, PathBuf}, sync::Arc, time::{Duration, SystemTime}};
use tokio::sync::{Mutex, RwLock, broadcast};
use tokio_stream::{StreamExt, wrappers::BroadcastStream};
use tower_http::services::{ServeDir, ServeFile};

const SESSION_DAYS: i64 = 30;
const COOKIE_NAME: &str = "coolapk_access";
const MAX_JSON_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug)]
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
impl From<String> for ApiError {
    fn from(value: String) -> Self { Self(StatusCode::BAD_REQUEST, value) }
}
impl From<&str> for ApiError {
    fn from(value: &str) -> Self { Self(StatusCode::BAD_REQUEST, value.to_string()) }
}
type ApiResult<T> = Result<T, ApiError>;

#[derive(Default, Serialize, Deserialize)]
struct AccessConfig {
    password_hash: String,
    #[serde(default)]
    sessions: Vec<AccessSession>,
}
#[derive(Serialize, Deserialize)]
struct AccessSession { hash: String, expires: i64 }

pub struct AppState {
    client: CoolapkClient,
    downloads: download_manager::DownloadManager,
    data_dir: PathBuf,
    static_dir: PathBuf,
    access: Mutex<AccessConfig>,
    // Account switches and persistent account writes share one gate. Read-only
    // requests can run concurrently; their cookie/identity snapshot is upstream.
    account_gate: RwLock<()>,
    stores_gate: Mutex<()>,
    public_origin: Option<String>,
    events: broadcast::Sender<(String, Value)>,
    uploads: uploads::UploadState,
}

impl AppState {
    async fn new(data_dir: PathBuf, static_dir: PathBuf, password: Option<String>, public_origin: Option<String>) -> anyhow::Result<Arc<Self>> {
        for dir in ["accounts", "settings", "cache", "downloads", "exports", "uploads"] {
            tokio::fs::create_dir_all(data_dir.join(dir)).await?;
        }
        let data_dir = tokio::fs::canonicalize(data_dir).await?;
        let access_path = data_dir.join("settings/access.json");
        let mut access: AccessConfig = match tokio::fs::read(&access_path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("访问配置损坏，请恢复 settings/access.json 备份"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AccessConfig::default(),
            Err(error) => return Err(error.into()),
        };
        if let Some(password) = password.filter(|value| !value.is_empty()) {
            validate_password(&password).map_err(anyhow::Error::msg)?;
            // An unchanged environment password preserves remembered sessions.
            if !bcrypt::verify(&password, &access.password_hash).unwrap_or(false) {
                access.password_hash = bcrypt::hash(password, 10)?;
                access.sessions.clear();
                write_json_atomic(&access_path, &serde_json::to_value(&access)?).await.map_err(anyhow::Error::msg)?;
            }
        }
        access.sessions.retain(|session| session.expires > chrono::Utc::now().timestamp());
        let client = CoolapkClient::new();
        client.persist_cookie_to(data_dir.join("accounts/session_cookie.txt"));
        // Keep the default guest device identity stable even before first login.
        client.sync_device_code();
        if let Ok(bytes) = tokio::fs::read(data_dir.join("settings/device-profile.json")).await {
            if let Ok(profile) = serde_json::from_slice::<DeviceProfile>(&bytes) { client.update_device_profile(profile); }
        }
        let (events, _) = broadcast::channel(128);
        let state = Arc::new(Self {
            client, downloads: download_manager::DownloadManager::new(), data_dir, static_dir,
            access: Mutex::new(access), account_gate: RwLock::new(()), stores_gate: Mutex::new(()), public_origin, events, uploads: uploads::UploadState::default(),
        });
        uploads::cleanup_and_usage(&state, true).map_err(anyhow::Error::msg)?;
        Ok(state)
    }
    pub fn emit(&self, name: &str, payload: Value) -> Result<(), String> {
        let _ = self.events.send((name.to_string(), payload));
        Ok(())
    }
    async fn authenticated(&self, headers: &HeaderMap) -> bool {
        let Some(token) = cookie_token(headers) else { return false; };
        let hash = token_hash(&token);
        let access = self.access.lock().await;
        let now = chrono::Utc::now().timestamp();
        access.sessions.iter().any(|session| session.expires > now && session.hash == hash)
    }
    async fn save_access(&self, access: &AccessConfig) -> Result<(), String> {
        write_json_atomic(&self.data_dir.join("settings/access.json"), &serde_json::to_value(access).map_err(|e| e.to_string())?).await
    }
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 10 || password.len() > 72 {
        return Err("访问密码至少 10 个字符，且 UTF-8 长度不超过 72 字节".into());
    }
    Ok(())
}
fn token_hash(token: &str) -> String { hex::encode(Sha256::digest(token.as_bytes())) }
fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    cookies.split(';').filter_map(|part| part.trim().split_once('=')).find(|(name, _)| *name == COOKIE_NAME).map(|(_, value)| value.to_string())
}
fn session_cookie(token: &str, headers: &HeaderMap, public_origin: Option<&str>, clear: bool) -> ApiResult<HeaderValue> {
    let secure = public_origin.is_some_and(|origin| origin.starts_with("https://")) || headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).is_some_and(|v| v == "https");
    let seconds = if clear { 0 } else { SESSION_DAYS * 86400 };
    HeaderValue::from_str(&format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={seconds}{}", if secure { "; Secure" } else { "" })).map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "无法设置访问会话".into()))
}
fn issue_session(access: &mut AccessConfig) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "系统随机数不可用".to_string())?;
    let token = hex::encode(bytes);
    access.sessions.retain(|session| session.expires > chrono::Utc::now().timestamp());
    // Limit remembered browsers without allowing unbounded session storage.
    if access.sessions.len() >= 32 { access.sessions.remove(0); }
    access.sessions.push(AccessSession { hash: token_hash(&token), expires: chrono::Utc::now().timestamp() + SESSION_DAYS * 86400 });
    Ok(token)
}

fn origin_allowed(headers: &HeaderMap, expected: Option<&str>) -> bool {
    if headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") { return false; }
    let Some(raw) = headers.get(header::ORIGIN) else { return true; };
    let Ok(origin) = raw.to_str() else { return false; };
    let Ok(parsed) = reqwest::Url::parse(origin) else { return false; };
    if !matches!(parsed.scheme(), "http" | "https") || parsed.path() != "/" || parsed.query().is_some() || !parsed.username().is_empty() { return false; }
    if let Some(expected) = expected {
        return reqwest::Url::parse(expected).map(|value| value.origin() == parsed.origin()).unwrap_or(false);
    }
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else { return false; };
    // The externally visible host is preserved by Lucky. Do not trust arbitrary
    // X-Forwarded-Host supplied by an internet caller.
    reqwest::Url::parse(&format!("{}://{host}", parsed.scheme())).map(|url| url.origin() == parsed.origin()).unwrap_or(false)
}
async fn protect(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    if !origin_allowed(req.headers(), state.public_origin.as_deref()) {
        return ApiError(StatusCode::FORBIDDEN, "请求来源不匹配".into()).into_response();
    }
    let path = req.uri().path();
    if !(path.starts_with("/api/auth/") || path.starts_with("/auth/")) && !state.authenticated(req.headers()).await {
        return ApiError(StatusCode::UNAUTHORIZED, "请先验证网页访问密码".into()).into_response();
    }
    let mut response = next.run(req).await;
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    response
}

#[derive(Deserialize)]
struct PasswordInput { password: String }
async fn auth_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Json<Value> {
    let configured = !state.access.lock().await.password_hash.is_empty();
    Json(json!({"configured": configured, "authenticated": state.authenticated(&headers).await}))
}
async fn auth_setup(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(input): Json<PasswordInput>) -> ApiResult<Response> {
    validate_password(&input.password)?;
    let mut access = state.access.lock().await;
    if !access.password_hash.is_empty() { return Err(ApiError(StatusCode::CONFLICT, "访问密码已经设置".into())); }
    let password = input.password;
    access.password_hash = tokio::task::spawn_blocking(move || bcrypt::hash(password, 10)).await.map_err(|_| "密码处理失败".to_string())?.map_err(|_| "密码处理失败".to_string())?;
    let token = issue_session(&mut access)?;
    state.save_access(&access).await?;
    Ok(([(header::SET_COOKIE, session_cookie(&token, &headers, state.public_origin.as_deref(), false)?)], Json(json!({"authenticated": true}))).into_response())
}
async fn auth_login(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(input): Json<PasswordInput>) -> ApiResult<Response> {
    if input.password.len() > 72 { return Err(ApiError(StatusCode::UNAUTHORIZED, "访问密码错误".into())); }
    let hash = state.access.lock().await.password_hash.clone();
    let valid = tokio::task::spawn_blocking(move || bcrypt::verify(input.password, &hash).unwrap_or(false)).await.unwrap_or(false);
    if !valid {
        tokio::time::sleep(Duration::from_millis(400)).await;
        return Err(ApiError(StatusCode::UNAUTHORIZED, "访问密码错误".into()));
    }
    let mut access = state.access.lock().await;
    let token = issue_session(&mut access)?;
    state.save_access(&access).await?;
    Ok(([(header::SET_COOKIE, session_cookie(&token, &headers, state.public_origin.as_deref(), false)?)], Json(json!({"authenticated": true}))).into_response())
}
async fn auth_logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = cookie_token(&headers) {
        let mut access = state.access.lock().await;
        access.sessions.retain(|session| session.hash != token_hash(&token));
        state.save_access(&access).await?;
    }
    Ok(([(header::SET_COOKIE, session_cookie("", &headers, state.public_origin.as_deref(), true)?)], Json(json!({"authenticated": false}))).into_response())
}

pub fn arg<T: DeserializeOwned>(args: &Value, camel: &str, snake: &str, optional: bool) -> Result<T, String> {
    let value = match args.get(camel).or_else(|| args.get(snake)) {
        Some(value) => value.clone(),
        None if optional => Value::Null,
        None => return Err(format!("缺少参数：{camel}")),
    };
    serde_json::from_value(value).map_err(|_| format!("参数格式不正确：{camel}"))
}
fn store_filename(name: &str) -> Result<&str, String> {
    if name.len() > 100 || !name.ends_with(".json") || name.contains("..") || name.starts_with('.') || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) || ["accounts.json", "access.json", "sessions.json", "device-profile.json"].contains(&name) {
        return Err("存储文件名不合法或属于受保护的凭据文件".into());
    }
    Ok(name)
}
async fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "无法序列化存储数据".to_string())?;
    if bytes.len() > MAX_JSON_BYTES { return Err("存储数据超过 32MB".into()); }
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|_| "系统随机数不可用".to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", hex::encode(nonce)));
    tokio::fs::write(&temporary, bytes).await.map_err(|_| "无法写入持久化目录".to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await.map_err(|_| "无法保护持久化文件权限".to_string())?;
    }
    tokio::fs::rename(&temporary, path).await.map_err(|_| "无法保存持久化文件".to_string())
}
pub fn write_accounts_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|_| std::io::Error::other("random generator unavailable"))?;
    let temporary = path.with_extension(format!("{}.tmp", hex::encode(nonce)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, path)?;
    Ok(())
}
async fn store_get(State(state): State<Arc<AppState>>, HttpPath(name): HttpPath<String>) -> ApiResult<Json<Value>> {
    let name = store_filename(&name)?;
    let path = state.data_dir.join("settings").join(name);
    reject_symlink(&path)?;
    let value = match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "存储文件损坏，请恢复备份".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(_) => return Err("无法读取持久化文件".to_string().into()),
    };
    Ok(Json(value))
}
async fn store_put(State(state): State<Arc<AppState>>, HttpPath(name): HttpPath<String>, Json(value): Json<Value>) -> ApiResult<Json<Value>> {
    let name = store_filename(&name)?;
    if !value.is_object() { return Err("存储数据必须为 JSON 对象".to_string().into()); }
    let _gate = state.stores_gate.lock().await;
    let path = state.data_dir.join("settings").join(name);
    reject_symlink(&path)?;
    write_json_atomic(&path, &value).await?;
    Ok(Json(json!({"saved": true})))
}

fn protected_command(command: &str) -> bool {
    matches!(command, "save_cookie_securely" | "save_account" | "persist_current_account" | "login_as" | "remove_account" | "clear_user_cookie" | "login_by_account" | "login_by_mobile" | "update_device_profile")
}
async fn invoke(State(state): State<Arc<AppState>>, HttpPath(command): HttpPath<String>, Json(args): Json<Value>) -> ApiResult<Json<Value>> {
    if !args.is_object() { return Err("命令参数必须为 JSON 对象".to_string().into()); }
    let _write_gate = if protected_command(&command) { Some(tokio::time::timeout(Duration::from_secs(15), state.account_gate.write()).await.map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "账户请求正在处理，请稍后重试".into()))?) } else { None };
    let _read_gate = if !protected_command(&command) && !matches!(command.as_str(), "start_apk_download" | "pause_apk_download" | "cancel_apk_download" | "upload_file_to_cdn" | "cancel_cdn_upload") { Some(tokio::time::timeout(Duration::from_secs(15), state.account_gate.read()).await.map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "账户正在切换，请稍后重试".into()))?) } else { None };
    let result = if command == "upload_file_to_cdn" {
        uploads::start(&state, &args).await
    } else if command == "cancel_cdn_upload" {
        uploads::cancel(&state, &args).await
    } else if command == "start_apk_download" {
        dispatch_generated::dispatch(&state, &command, &args).await
    } else {
        tokio::time::timeout(Duration::from_secs(60), dispatch_web(&state, &command, &args)).await.map_err(|_| "酷安请求超时，请稍后重试".to_string())?
    }?;
    Ok(Json(redact_secrets(result)))
}
// Some upstream login responses contain token fields. Credentials always remain
// server-side even when an API response happens to contain them.
fn redact_secrets(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(object.into_iter().filter(|(key, _)| !matches!(key.to_ascii_lowercase().as_str(), "cookie" | "sessid" | "token" | "accesstoken" | "access_token" | "refreshtoken" | "refresh_token" | "password" | "authorization")).map(|(key, value)| (key, redact_secrets(value))).collect()),
        Value::Array(array) => Value::Array(array.into_iter().map(redact_secrets).collect()),
        other => other,
    }
}
async fn dispatch_web(state: &AppState, command: &str, args: &Value) -> Result<Value, String> {
    match command {
        "take_update_install_error" => Ok(Value::Null),
        "get_user_cookie" => Ok(if state.client.get_user_cookie().is_some() { json!("stored-on-server") } else { Value::Null }),
        "check_login_status" => state.client.check_login_status().await,
        "check_login_info" => state.client.check_login_info().await,
        "save_cookie_securely" => {
            let cookie: String = arg(args, "cookieStr", "cookie_str", false)?;
            let previous = state.client.get_user_cookie();
            match state.client.login_by_webview_cookie(&cookie).await {
                Ok(_) => Ok(json!("登录 Cookie 已验证并保存至 Docker 数据目录")),
                Err(error) => {
                    if let Some(cookie) = previous { state.client.set_user_cookie(cookie)?; } else { state.client.clear_user_cookie()?; }
                    Err(error)
                }
            }
        }
        "update_device_profile" => {
            let profile = args.get("profile").cloned().ok_or("缺少参数：profile")?;
            let parsed: DeviceProfile = serde_json::from_value(profile.clone()).map_err(|_| "设备配置格式不正确")?;
            write_json_atomic(&state.data_dir.join("settings/device-profile.json"), &profile).await?;
            state.client.update_device_profile(parsed);
            Ok(json!({"code":200,"data":true}))
        }
        "get_image_data_url" => {
            let url: String = arg(args, "url", "url", false)?;
            validate_media_url(&url)?;
            let ttl: Option<u64> = arg(args, "cacheTtlDays", "cache_ttl_days", true)?;
            let path = state.data_dir.join("cache").join(format!("{}.json", token_hash(&url)));
            if let Ok(metadata) = tokio::fs::metadata(&path).await {
                if ttl.unwrap_or(7) > 0 && metadata.modified().ok().and_then(|mtime| mtime.elapsed().ok()).is_some_and(|age| age < Duration::from_secs(ttl.unwrap_or(7).saturating_mul(86400))) {
                    if let Ok(bytes) = tokio::fs::read(&path).await { if let Ok(value) = serde_json::from_slice::<Value>(&bytes) { return Ok(value); } }
                }
            }
            let result = json!(state.client.get_image_data_url(&url).await?);
            let _ = write_json_atomic(&path, &result).await;
            Ok(result)
        }
        "fetch_external_page" => {
            let url: String = arg(args, "url", "url", false)?;
            // A NAS must never fetch arbitrary LAN or metadata-service addresses.
            validate_media_url(&url)?;
            state.client.fetch_external_page(&url).await
        }
        "get_download_directory" => Ok(json!(state.data_dir.join("downloads").to_string_lossy())),
        "create_export_directory" => {
            let name: String = arg(args, "directoryName", "directory_name", false)?;
            let name = safe_filename(&name)?;
            let requested: Option<String> = arg(args, "dir", "dir", true)?;
            let parent = export_directory(state, requested.as_deref())?;
            let dir = next_available_file_path(&parent, &name);
            tokio::fs::create_dir(&dir).await.map_err(|_| "无法创建导出目录")?;
            Ok(json!(dir.to_string_lossy()))
        }
        "export_json_file" => {
            let name: String = arg(args, "fileName", "file_name", false)?;
            let content: String = arg(args, "content", "content", false)?;
            let dir: Option<String> = arg(args, "dir", "dir", true)?;
            let dir = export_directory(state, dir.as_deref())?;
            let path = save_export_bytes(&dir, &safe_filename(&name)?, content.as_bytes()).await?;
            Ok(json!(path.to_string_lossy()))
        }
        "save_image" | "save_image_data_url" => {
            let dir: Option<String> = arg(args, "dir", "dir", true)?;
            let data_url = if command == "save_image" {
                let url: String = arg(args, "url", "url", false)?;
                if url.starts_with("data:image/") { url } else {
                    validate_media_url(&url)?;
                    state.client.get_image_data_url(&url).await?
                }
            } else { arg::<String>(args, "dataUrl", "data_url", false)? };
            let (prefix, encoded) = data_url.split_once(',').filter(|(prefix, _)| prefix.starts_with("data:image/") && prefix.ends_with(";base64")).ok_or("图片 data URL 不合法")?;
            let extension = match prefix { "data:image/png;base64" => "png", "data:image/gif;base64" => "gif", "data:image/webp;base64" => "webp", "data:image/avif;base64" => "avif", "data:image/bmp;base64" => "bmp", _ => "jpg" };
            let requested_name: Option<String> = arg(args, "fileName", "file_name", true)?;
            let mut name = requested_name.unwrap_or_else(|| format!("coolapk_image_{}.{}", chrono::Utc::now().timestamp_millis(), extension));
            if Path::new(&name).extension().is_none() { name.push_str(&format!(".{extension}")); }
            let bytes = BASE64.decode(encoded).map_err(|_| "图片 Base64 不合法")?;
            let dir = export_directory(state, dir.as_deref())?;
            let path = save_export_bytes(&dir, &safe_filename(&name)?, &bytes).await?;
            Ok(json!(path.to_string_lossy()))
        }
        "get_cache_info" => cache_info(state).await,
        "clear_app_cache" => {
            for entry in regular_files(&state.data_dir.join("cache")).await? { tokio::fs::remove_file(entry).await.map_err(|_| "缓存清理失败")?; }
            cache_info(state).await
        }
        "clean_expired_cache" => {
            let days: u64 = arg(args, "cacheTtlDays", "cache_ttl_days", false)?;
            if days > 0 {
                for entry in regular_files(&state.data_dir.join("cache")).await? {
                    if tokio::fs::metadata(&entry).await.ok().and_then(|meta| meta.modified().ok()).and_then(|mtime| SystemTime::now().duration_since(mtime).ok()).is_some_and(|age| age > Duration::from_secs(days.saturating_mul(86400))) { let _ = tokio::fs::remove_file(entry).await; }
                }
            }
            cache_info(state).await
        }
        "get_update_distribution" => Ok(json!("docker")),
        "get_diagnostic_verbose" => Ok(json!(false)),
        "set_diagnostic_verbose" | "clear_diagnostic_logs" | "close_login_window" | "cleanup_update_packages" => Ok(Value::Null),
        "get_diagnostic_logs" => Ok(json!({"files":[],"content":"网页服务日志请使用 docker compose logs 查看。","directory":"Docker logs"})),
        "get_platform_info" => Ok(json!({"platform":"web","isMobile":false,"isDesktop":false,"version":"docker"})),
        "sync_login_webview" => Ok(json!(false)),
        "open_login_webview" => Err("网页环境不支持官方桌面授权窗口，请在登录页使用 SESSID Cookie 导入".into()),
        "download_update" | "install_update" | "is_update_package_available" => Err("Docker 网页版请通过 docker compose 更新镜像".into()),
        "open_cache_directory" => Ok(json!(state.data_dir.join("cache").to_string_lossy())),
        "quit_app" => Err("网页无需退出服务器，可关闭浏览器标签页".into()),
        _ => dispatch_generated::dispatch(state, command, args).await,
    }
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) { return Err("拒绝访问符号链接".into()); }
    Ok(())
}
pub fn validate_custom_dir(raw: &str, label: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() || path.components().any(|component| matches!(component, Component::ParentDir)) { return Err(format!("{label}路径不合法")); }
    Ok(path)
}
pub fn user_save_dir(app: &AppState, dir: Option<&str>) -> Result<PathBuf, String> {
    let root = app.data_dir.join("downloads");
    if let Some(dir) = dir.filter(|value| !value.trim().is_empty()) {
        let path = validate_custom_dir(dir, "下载目录")?;
        return confined_directory(&root, &path);
    }
    Ok(root)
}
fn export_directory(state: &AppState, dir: Option<&str>) -> Result<PathBuf, String> {
    let Some(dir) = dir.filter(|value| !value.trim().is_empty()) else { return Ok(state.data_dir.join("exports")); };
    let path = validate_custom_dir(dir, "导出目录")?;
    for root in [state.data_dir.join("exports"), state.data_dir.join("downloads")] {
        if path.starts_with(&root) { return confined_directory(&root, &path); }
    }
    Err("导出文件必须位于 Docker 数据目录的 exports 或 downloads 中".into())
}
fn confined_directory(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path.strip_prefix(root).map_err(|_| "目录超出 Docker 数据目录")?;
    reject_symlink(root)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else { return Err("目录路径不合法".into()); };
        current.push(name);
        reject_symlink(&current)?;
        if !current.exists() { std::fs::create_dir(&current).map_err(|_| "无法创建保存目录")?; }
        if !current.is_dir() { return Err("保存位置不是目录".into()); }
    }
    let canonical = std::fs::canonicalize(&current).map_err(|_| "无法访问保存目录")?;
    let canonical_root = std::fs::canonicalize(root).map_err(|_| "无法访问 Docker 数据目录")?;
    if !canonical.starts_with(canonical_root) { return Err("目录超出 Docker 数据目录".into()); }
    Ok(canonical)
}
fn safe_filename(name: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 200 || name.contains("..") || name.contains(['/', '\\']) || name.chars().any(|c| c.is_control()) || name.starts_with('.') { return Err("文件名不合法".into()); }
    Ok(name.to_string())
}
async fn save_export_bytes(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    use tokio::io::AsyncWriteExt;
    for _ in 0..100 {
        let path = next_available_file_path(dir, name);
        match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await {
            Ok(mut file) => {
                file.write_all(bytes).await.map_err(|_| "无法保存导出文件")?;
                file.flush().await.map_err(|_| "无法保存导出文件")?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建导出文件".into()),
        }
    }
    Err("导出文件名正在使用，请稍后重试".into())
}
pub fn next_available_file_path(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    if !path.exists() && !path.with_file_name(format!("{name}.part")).exists() { return path; }
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    for index in 1..10000 {
        let name = format!("{stem}-{index}{}", if ext.is_empty() { String::new() } else { format!(".{ext}") });
        let candidate = dir.join(&name);
        if !candidate.exists() && !dir.join(format!("{name}.part")).exists() { return candidate; }
    }
    dir.join(format!("{stem}-{}.{}", chrono::Utc::now().timestamp_millis(), ext))
}
async fn regular_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut entries = tokio::fs::read_dir(dir).await.map_err(|_| "无法读取目录")?;
    let mut paths = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|_| "无法读取目录")? { if entry.file_type().await.map_err(|_| "无法读取文件属性")?.is_file() { paths.push(entry.path()); } }
    Ok(paths)
}
async fn cache_info(state: &AppState) -> Result<Value, String> {
    let mut bytes = 0;
    for file in regular_files(&state.data_dir.join("cache")).await? { bytes += tokio::fs::metadata(file).await.map(|meta| meta.len()).unwrap_or(0); }
    Ok(json!({"bytes":bytes,"imageBytes":bytes,"webviewBytes":0,"updateBytes":0,"path":state.data_dir.join("cache").to_string_lossy()}))
}

fn validate_media_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "媒体地址不合法")?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed = ["coolapk.com", "coolapkmarket.com", "sinaimg.cn", "weibocdn.com", "weibo.com", "miaopai.com", "qq.com", "qpic.cn", "qcloud.com", "myqcloud.com", "bilibili.com", "bilivideo.com", "hdslb.com"];
    if !matches!(url.scheme(), "http" | "https") || url.port().is_some_and(|port| ![80, 443].contains(&port)) || !url.username().is_empty() || url.password().is_some() || !allowed.iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}"))) {
        return Err("媒体代理仅允许酷安及支持的公开媒体域名".into());
    }
    Ok(url)
}
pub fn secure_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 || validate_media_url(attempt.url().as_str()).is_err() {
            attempt.error("拒绝跳转至不受信任的地址")
        } else { attempt.follow() }
    })
}
#[derive(Deserialize)]
struct MediaQuery { url: String }
async fn media(State(state): State<Arc<AppState>>, Query(query): Query<MediaQuery>, headers: HeaderMap) -> ApiResult<Response> {
    let url = validate_media_url(&query.url)?;
    let host = url.host_str().unwrap_or_default();
    let official = host == "coolapk.com" || host.ends_with(".coolapk.com");
    let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).redirect(reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 || validate_media_url(attempt.url().as_str()).is_err() { attempt.error("媒体跳转地址不受信任") } else { attempt.follow() }
    })).build().map_err(|_| "无法创建媒体连接")?;
    let mut request = client.get(url.clone()).header("User-Agent", "Mozilla/5.0").header("Referer", if host.ends_with("sinaimg.cn") || host.ends_with("weibocdn.com") { "https://weibo.com/" } else { "https://www.coolapk.com/" });
    if official {
        request = state.client.apply_download_headers(request)?;
        if let Some(cookie) = state.client.get_user_cookie() { request = request.header(header::COOKIE, cookie); }
    }
    for name in [header::RANGE, header::IF_RANGE] { if let Some(value) = headers.get(&name) { request = request.header(name, value); } }
    let upstream = request.send().await.map_err(|_| "媒体请求失败")?;
    let status = StatusCode::from_u16(upstream.status().as_u16()).map_err(|_| "媒体响应无效")?;
    let content_type = upstream.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream");
    if content_type.starts_with("text/html") || content_type.starts_with("application/xhtml") { return Err("媒体代理拒绝 HTML 页面".to_string().into()); }
    let mut builder = Response::builder().status(status);
    for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES, header::ETAG, header::LAST_MODIFIED] { if let Some(value) = upstream.headers().get(&name) { builder = builder.header(name, value); } }
    builder.header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox; default-src 'none'").body(Body::from_stream(upstream.bytes_stream())).map_err(|_| "无法输出媒体响应".to_string().into())
}

async fn events(State(state): State<Arc<AppState>>) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(state.events.subscribe()).filter_map(|message| message.ok().map(|(name, value)| Ok(Event::default().event(name).data(value.to_string()))));
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20)).text("keepalive"))
}
async fn files_list(State(state): State<Arc<AppState>>) -> ApiResult<Json<Value>> {
    let mut files = Vec::new();
    for kind in ["downloads", "exports"] {
        let mut pending = vec![(state.data_dir.join(kind), 0usize)];
        while let Some((dir, depth)) = pending.pop() {
          let mut entries = tokio::fs::read_dir(dir).await.map_err(|_| "无法读取文件目录")?;
          while let Some(entry) = entries.next_entry().await.map_err(|_| "无法读取文件目录")? {
            let kind_type = entry.file_type().await.map_err(|_| "无法读取文件属性")?;
            if kind_type.is_dir() && depth < 8 { pending.push((entry.path(), depth + 1)); }
            if !kind_type.is_file() || files.len() >= 10000 { continue; }
            let path = entry.path();
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
            if name.ends_with(".part") { continue; }
            let size = tokio::fs::metadata(&path).await.map(|meta| meta.len()).unwrap_or(0);
            let relative = path.strip_prefix(&state.data_dir).map_err(|_| "文件路径不合法")?.to_string_lossy().replace('\\', "/");
            files.push(json!({"name":name,"path":relative,"url":format!("/api/files/{relative}"),"size":size}));
          }
        }
    }
    Ok(Json(json!({"files":files})))
}
async fn file_get(State(state): State<Arc<AppState>>, HttpPath(relative): HttpPath<String>, req: Request) -> ApiResult<Response> {
    let components: Vec<_> = Path::new(&relative).components().collect();
    if !components.iter().all(|component| matches!(component, Component::Normal(_))) || !relative.starts_with("downloads/") && !relative.starts_with("exports/") { return Err("文件路径不合法".to_string().into()); }
    let root = state.data_dir.clone();
    let path = root.join(&relative);
    reject_symlink(&path)?;
    let canonical = tokio::fs::canonicalize(&path).await.map_err(|_| ApiError(StatusCode::NOT_FOUND, "文件不存在".into()))?;
    if !canonical.starts_with(root.join("downloads")) && !canonical.starts_with(root.join("exports")) { return Err("文件路径超出下载目录".to_string().into()); }
    use tower::ServiceExt;
    let response = ServeFile::new(canonical).oneshot(req).await.map_err(|_| "无法读取下载文件")?;
    let mut response = response.into_response();
    response.headers_mut().insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    Ok(response)
}

fn app(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/auth/status", get(auth_status))
        .route("/auth/setup", post(auth_setup))
        .route("/auth/login", post(auth_login))
        .route("/auth/logout", post(auth_logout))
        .route("/invoke/{command}", post(invoke))
        .route("/store/{name}", get(store_get).put(store_put).post(store_put))
        .route("/media", get(media))
        .route("/events", get(events))
        .route("/files", get(files_list))
        .route("/files/{*relative}", get(file_get))
        .layer(DefaultBodyLimit::max(MAX_JSON_BYTES));
    let api = api.merge(uploads::routes())
        .layer(middleware::from_fn_with_state(state.clone(), protect));
    Router::new()
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .nest("/api", api)
        .fallback_service(ServeDir::new(&state.static_dir).fallback(ServeFile::new(state.static_dir.join("index.html"))))
        .with_state(state)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn,coolapk_web_server=info".into())).init();
    let data = std::env::var_os("COOLAPK_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("./data"));
    let static_dir = std::env::var_os("COOLAPK_STATIC_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("../dist"));
    let state = AppState::new(data, static_dir, std::env::var("COOLAPK_ACCESS_PASSWORD").ok(), std::env::var("COOLAPK_PUBLIC_ORIGIN").ok().filter(|value| !value.is_empty())).await?;
    let port: u16 = std::env::var("COOLAPK_PORT").unwrap_or_else(|_| "8080".into()).parse()?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("Coolapk web service listening on port {port}; commands={}", dispatch_generated::COMMANDS.len());
    axum::serve(listener, app(state)).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}
async fn shutdown_signal() {
    #[cfg(unix)] {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("install terminate handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))] { let _ = tokio::signal::ctrl_c().await; }
}

#[cfg(test)]
mod tests;
