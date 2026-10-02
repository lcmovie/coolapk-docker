use super::*;
use axum::http::Request;
use http_body_util::BodyExt;
use tempfile::TempDir;
use tower::ServiceExt;

async fn stage_call(router: &Router, access: Option<&str>, path: &str, bytes: Vec<u8>) -> Response {
    let mut request = Request::builder().method("POST").uri(path).header("Host", "coolapk.test").header(header::CONTENT_TYPE, "application/octet-stream");
    if let Some(access) = access { request = request.header(header::COOKIE, access); }
    router.clone().oneshot(request.body(Body::from(bytes)).unwrap()).await.unwrap()
}

#[tokio::test]
async fn staged_uploads_require_auth_and_reject_paths_and_unknown_purposes() {
    let (_temp, state, router) = fixture().await;
    assert_eq!(stage_call(&router, None, "/api/uploads/stage?name=fixture.txt", b"synthetic".to_vec()).await.status(), StatusCode::UNAUTHORIZED);
    let access = setup(&router).await;
    for url in ["/api/uploads/stage?name=..%2Faccount.json", "/api/uploads/stage?name=fixture.txt&purpose=accounts", "/api/uploads/stage?name=.hidden"] {
        assert_eq!(stage_call(&router, Some(&access), url, b"synthetic".to_vec()).await.status(), StatusCode::BAD_REQUEST);
    }
    let response = router.clone().oneshot(Request::builder().method("POST").uri("/api/uploads/stage?name=fixture.txt").header("Host", "coolapk.test").header("Origin", "https://evil.test").header(header::COOKIE, &access).header(header::CONTENT_TYPE, "application/octet-stream").body(Body::from("synthetic")).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(std::fs::read_dir(state.data_dir.join("uploads")).unwrap().count(), 0);
    for path in ["/etc/passwd", "../accounts/accounts.json", "upload:../accounts.json"] {
        let response = call(&router, "POST", "/api/invoke/upload_file_to_cdn", Some(&access), json!({"taskId":"synthetic","attempt":1,"filePath":path})).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    assert_eq!(response_json(call(&router, "POST", "/api/invoke/cancel_cdn_upload", Some(&access), json!({"taskId":"absent"})).await).await, json!(false));
}

#[tokio::test]
async fn staged_file_roundtrip_is_private_persistent_and_released_idempotently() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    let staged = response_json(stage_call(&router, Some(&access), "/api/uploads/stage?name=fixture.txt", b"synthetic staged payload".to_vec()).await).await;
    let path = staged["filePath"].as_str().unwrap();
    assert!(path.starts_with("upload:"));
    assert!(!staged.to_string().contains(state.data_dir.to_str().unwrap()));
    let token = &path[7..];
    let restored = AppState::new(state.data_dir.clone(), state.static_dir.clone(), None, None).await.unwrap();
    let router = app(restored);
    let response = call(&router, "GET", &format!("/api/uploads/stage/{token}"), Some(&access), json!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_DISPOSITION], "attachment");
    assert!(response.headers()[header::CACHE_CONTROL].to_str().unwrap().contains("no-store"));
    assert_eq!(response.into_body().collect().await.unwrap().to_bytes(), b"synthetic staged payload"[..]);
    assert_eq!(call(&router, "GET", &format!("/api/files/uploads/{token}/body/fixture.txt"), Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
    for _ in 0..2 { assert_eq!(call(&router, "DELETE", &format!("/api/uploads/stage/{token}"), Some(&access), json!({})).await.status(), StatusCode::OK); }
    assert_eq!(call(&router, "GET", &format!("/api/uploads/stage/{token}"), Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn draft_files_do_not_expire_or_become_cdn_jobs_and_orphans_are_removed_at_restart() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    let mut paths = Vec::new();
    for purpose in ["draft", "cdn"] {
        let result = response_json(stage_call(&router, Some(&access), &format!("/api/uploads/stage?name=fixture.txt&purpose={purpose}"), b"synthetic".to_vec()).await).await;
        let path = result["filePath"].as_str().unwrap().to_string();
        let metadata = state.data_dir.join("uploads").join(&path[7..]).join("metadata.json");
        let mut value: Value = serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
        value["createdAt"] = json!(0);
        std::fs::write(metadata, value.to_string()).unwrap();
        paths.push(path);
    }
    let orphan = state.data_dir.join("uploads").join("a".repeat(64));
    std::fs::create_dir(&orphan).unwrap();
    std::fs::write(orphan.join("incomplete.tmp"), b"synthetic").unwrap();
    let restored = AppState::new(state.data_dir.clone(), state.static_dir.clone(), None, None).await.unwrap();
    let router = app(restored);
    assert!(!orphan.exists());
    assert_eq!(call(&router, "GET", &format!("/api/uploads/stage/{}", &paths[0][7..]), Some(&access), json!({})).await.status(), StatusCode::OK);
    assert_eq!(call(&router, "GET", &format!("/api/uploads/stage/{}", &paths[1][7..]), Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
    let response = call(&router, "POST", "/api/invoke/upload_file_to_cdn", Some(&access), json!({"taskId":"draft","attempt":1,"filePath":paths[0]})).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response_json(response).await["error"].as_str().unwrap().contains("草稿附件"));
}

#[tokio::test]
async fn draft_release_preserves_durable_references_after_an_uncertain_save() {
    let (_temp, _state, router) = fixture().await;
    let access = setup(&router).await;
    let staged = response_json(stage_call(&router, Some(&access), "/api/uploads/stage?name=fixture.txt&purpose=draft", b"synthetic".to_vec()).await).await;
    let path = staged["filePath"].as_str().unwrap();
    let url = format!("/api/uploads/stage/{}", &path[7..]);
    let draft = json!({"drafts":[{"images":[{"file":{"stagedPath":path,"name":"fixture.txt"}}]}]});
    assert_eq!(call(&router, "PUT", "/api/store/publish_drafts.json", Some(&access), draft).await.status(), StatusCode::OK);
    assert_eq!(call(&router, "DELETE", &url, Some(&access), json!({})).await.status(), StatusCode::CONFLICT);
    assert_eq!(call(&router, "GET", &url, Some(&access), json!({})).await.status(), StatusCode::OK);
    assert_eq!(call(&router, "PUT", "/api/store/publish_drafts.json", Some(&access), json!({"drafts":[]})).await.status(), StatusCode::OK);
    assert_eq!(call(&router, "DELETE", &url, Some(&access), json!({})).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn binary_upload_limit_is_separate_from_json_and_partial_failures_leave_no_file() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    // Exercise a real body larger than the JSON limit without any upstream request.
    let response = stage_call(&router, Some(&access), "/api/uploads/stage?name=large.bin", vec![0u8; MAX_JSON_BYTES + 1]).await;
    assert_eq!(response.status(), StatusCode::OK);
    let result = response_json(response).await;
    let token = &result["filePath"].as_str().unwrap()[7..];
    assert_eq!(result["size"], MAX_JSON_BYTES + 1);
    assert_eq!(call(&router, "DELETE", &format!("/api/uploads/stage/{token}"), Some(&access), json!({})).await.status(), StatusCode::OK);
    let response = router.clone().oneshot(Request::builder().method("POST").uri("/api/uploads/stage?name=too-large.bin").header("Host", "coolapk.test").header(header::COOKIE, &access).header(header::CONTENT_TYPE, "application/octet-stream").header(header::CONTENT_LENGTH, (uploads::MAX_FILE_BYTES + 1).to_string()).body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = Body::from_stream(tokio_stream::iter([Ok::<Vec<u8>, std::io::Error>(b"partial".to_vec()), Err(std::io::Error::other("synthetic interruption"))]));
    let response = router.clone().oneshot(Request::builder().method("POST").uri("/api/uploads/stage?name=partial.bin").header("Host", "coolapk.test").header(header::COOKIE, &access).header(header::CONTENT_TYPE, "application/octet-stream").body(body).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(std::fs::read_dir(state.data_dir.join("uploads")).unwrap().count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn staged_attachment_read_rejects_symlink_escape() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    let result = response_json(stage_call(&router, Some(&access), "/api/uploads/stage?name=fixture.txt", b"synthetic".to_vec()).await).await;
    let token = &result["filePath"].as_str().unwrap()[7..];
    let file = state.data_dir.join("uploads").join(token).join("body/fixture.txt");
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(state.data_dir.join("settings/access.json"), &file).unwrap();
    assert_eq!(call(&router, "GET", &format!("/api/uploads/stage/{token}"), Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn multipart_video_validation_precedes_network_and_auth_is_enforced() {
    let (_temp, state, router) = fixture().await;
    let body = "--fixture\r\nContent-Disposition: form-data; name=\"video\"; filename=\"fixture.mp4\"\r\nContent-Type: video/mp4\r\n\r\ninvalid\r\n--fixture\r\nContent-Disposition: form-data; name=\"cover\"; filename=\"cover.jpg\"\r\nContent-Type: image/jpeg\r\n\r\ninvalid\r\n--fixture\r\nContent-Disposition: form-data; name=\"duration\"\r\n\r\n1\r\n--fixture--\r\n";
    let request = || Request::builder().method("POST").uri("/api/uploads/publish-video").header("Host", "coolapk.test").header(header::CONTENT_TYPE, "multipart/form-data; boundary=fixture");
    assert_eq!(router.clone().oneshot(request().body(Body::from(body)).unwrap()).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let access = setup(&router).await;
    let response = router.clone().oneshot(request().header(header::COOKIE, &access).body(Body::from(body)).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response_json(response).await["error"].as_str().unwrap().contains("视频或封面"));
    assert_eq!(std::fs::read_dir(state.data_dir.join("uploads")).unwrap().count(), 0);
}

#[test]
fn uploads_never_send_temporary_credentials_to_untrusted_hosts() {
    for raw in ["http://bucket.oss-cn.aliyuncs.com/key", "https://127.0.0.1/key", "https://bucket.aliyuncs.com.evil.test/key", "https://evil.test/key", "https://u:p@bucket.aliyuncs.com/key", "https://bucket.aliyuncs.com:8000/key", "https://bucket.aliyuncs.com/key?token=synthetic"] { assert!(uploads::validate_oss_upload_url(raw).is_err()); }
    assert!(uploads::validate_oss_upload_url("https://bucket.oss-cn-hangzhou.aliyuncs.com/synthetic.png").is_ok());
    let generated = include_str!("coolapk/client_generated.rs");
    assert!(generated.contains(".redirect_client\n            .request(reqwest::Method::PUT"));
    assert!(generated.contains("self.redirect_client.put(url)"));
    let video = include_str!("../../src-tauri/src/coolapk/video_upload.rs");
    assert!(video.contains(".redirect(reqwest::redirect::Policy::none())"));
}

#[test]
fn official_image_media_uses_https_and_preserves_url_validation() {
    assert_eq!(normalize_media_url("http://image.coolapk.com/feed/probe.png?x=1").unwrap().as_str(), "https://image.coolapk.com/feed/probe.png?x=1");
    assert_eq!(normalize_media_url("https://image.coolapk.com/feed/probe.png").unwrap().scheme(), "https");
    assert_eq!(normalize_media_url("http://wx1.sinaimg.cn/probe.jpg").unwrap().scheme(), "http");
    assert!(normalize_media_url("http://127.0.0.1/probe.png").is_err());
    assert!(normalize_media_url("http://image.coolapk.com.evil.test/probe.png").is_err());
    assert!(normalize_media_url("https://image.coolapk.com:8080/probe.png").is_err());
}

#[test]
fn public_image_requests_keep_browser_headers_without_account_credentials() {
    let coolapk = CoolapkClient::new();
    coolapk.set_user_cookie("uid=123; SESSID=synthetic-test-session".to_string()).unwrap();
    let client = reqwest::Client::new();
    let image = create_media_request(&client, &coolapk, normalize_media_url("http://image.coolapk.com/feed/probe.png").unwrap()).unwrap().build().unwrap();
    assert_eq!(image.url().scheme(), "https");
    assert!(image.headers()[header::USER_AGENT].to_str().unwrap().contains("Chrome/"));
    assert_eq!(image.headers()[header::REFERER], "https://www.coolapk.com/");
    assert!(!image.headers().contains_key(header::COOKIE));
    assert!(!image.headers().contains_key("X-App-Token"));
    let api = create_media_request(&client, &coolapk, normalize_media_url("https://api.coolapk.com/v6/feed/video").unwrap()).unwrap().build().unwrap();
    assert!(api.headers().contains_key(header::COOKIE));
    assert!(api.headers().contains_key("X-App-Token"));
}

async fn fixture() -> (TempDir, Arc<AppState>, Router) {
    let temp = tempfile::tempdir().unwrap();
    let static_dir = temp.path().join("dist");
    tokio::fs::create_dir_all(&static_dir).await.unwrap();
    tokio::fs::write(static_dir.join("index.html"), "<html>Coolapk SPA</html>").await.unwrap();
    let state = AppState::new(temp.path().join("data"), static_dir, None, None).await.unwrap();
    let router = app(state.clone());
    (temp, state, router)
}
async fn call(router: &Router, method: &str, path: &str, cookie: Option<&str>, body: Value) -> Response {
    let mut builder = Request::builder().method(method).uri(path).header("Host", "coolapk.test");
    if let Some(cookie) = cookie { builder = builder.header(header::COOKIE, cookie); }
    router.clone().oneshot(builder.header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap()
}
async fn response_json(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn setup(router: &Router) -> String {
    let response = call(router, "POST", "/api/auth/setup", None, json!({"password":"fixture-access-password"})).await;
    assert_eq!(response.status(), StatusCode::OK);
    response.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string()
}

#[tokio::test]
async fn api_requires_authentication_and_status_is_public() {
    let (_temp, _state, router) = fixture().await;
    let status = response_json(call(&router, "GET", "/api/auth/status", None, json!({})).await).await;
    assert_eq!(status, json!({"configured":false,"authenticated":false}));
    assert_eq!(call(&router, "POST", "/api/invoke/list_accounts", None, json!({})).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(call(&router, "GET", "/healthz", None, json!({})).await.status(), StatusCode::OK);
    assert_eq!(call(&router, "GET", "/feed/123", None, json!({})).await.status(), StatusCode::OK);
}

#[tokio::test]
async fn access_password_hash_and_session_survive_server_recreation() {
    let (_temp, state, router) = fixture().await;
    let cookie = setup(&router).await;
    let bytes = tokio::fs::read(state.data_dir.join("settings/access.json")).await.unwrap();
    let serialized = String::from_utf8(bytes).unwrap();
    assert!(!serialized.contains("fixture-access-password"));
    assert!(!serialized.contains(cookie.split_once('=').unwrap().1));
    let restored = AppState::new(state.data_dir.clone(), state.static_dir.clone(), None, None).await.unwrap();
    let status = response_json(call(&app(restored), "GET", "/api/auth/status", Some(&cookie), json!({})).await).await;
    assert_eq!(status["authenticated"], true);
    let response = call(&router, "POST", "/api/auth/setup", None, json!({"password":"another-password"})).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let response = call(&router, "POST", "/api/auth/logout", Some(&cookie), json!({})).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(call(&router, "GET", "/api/store/browser-state.json", Some(&cookie), json!({})).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn browser_store_persists_and_credentials_are_not_accessible() {
    let (_temp, state, router) = fixture().await;
    let cookie = setup(&router).await;
    let value = json!({"theme":"dark","layout":{"width":1200}});
    assert_eq!(call(&router, "PUT", "/api/store/browser-state.json", Some(&cookie), value.clone()).await.status(), StatusCode::OK);
    let restored = AppState::new(state.data_dir.clone(), state.static_dir.clone(), None, None).await.unwrap();
    let returned = response_json(call(&app(restored), "GET", "/api/store/browser-state.json", Some(&cookie), json!({})).await).await;
    assert_eq!(returned, value);
    for name in ["accounts.json", "access.json", "sessions.json", "device-profile.json"] {
        assert_eq!(call(&router, "GET", &format!("/api/store/{name}"), Some(&cookie), json!({})).await.status(), StatusCode::BAD_REQUEST);
    }
    assert_eq!(call(&router, "PUT", "/api/store/web-smoke.json", Some(&cookie), json!([1,2])).await.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn account_cookie_is_restored_but_never_returned_to_browser() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    // Synthetic local-only credentials exercise persistence without logging in
    // to a real account or making any upstream write request.
    state.client.save_account("12345", "fixture", "", "SESSID=synthetic-session; uid=12345").await.unwrap();
    let list = response_json(call(&router, "POST", "/api/invoke/list_accounts", Some(&access), json!({})).await).await;
    assert!(!list.to_string().contains("synthetic-session"));
    assert_eq!(list["data"][0]["uid"], "12345");
    let returned = response_json(call(&router, "POST", "/api/invoke/get_user_cookie", Some(&access), json!({})).await).await;
    assert_eq!(returned, json!("stored-on-server"));
    let restored = AppState::new(state.data_dir.clone(), state.static_dir.clone(), None, None).await.unwrap();
    assert!(restored.client.get_user_cookie().unwrap().contains("synthetic-session"));
}

#[tokio::test]
async fn password_validation_and_origin_checks_prevent_cross_site_setup() {
    let (_temp, _state, router) = fixture().await;
    assert_eq!(call(&router, "POST", "/api/auth/setup", None, json!({"password":"short"})).await.status(), StatusCode::BAD_REQUEST);
    let response = router.oneshot(Request::builder().method("POST").uri("/api/auth/setup").header("Host", "coolapk.test").header("Origin", "https://evil.test").header(header::CONTENT_TYPE, "application/json").body(Body::from(json!({"password":"fixture-access-password"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let mut headers = HeaderMap::new();
    headers.insert(header::HOST, HeaderValue::from_static("coolapk.example.com:88"));
    headers.insert(header::ORIGIN, HeaderValue::from_static("https://coolapk.example.com:88"));
    assert!(origin_allowed(&headers, Some("https://coolapk.example.com:88")));
    headers.insert(header::ORIGIN, HeaderValue::from_static("https://coolapk.example.com"));
    assert!(!origin_allowed(&headers, Some("https://coolapk.example.com:88")));
}

#[test]
fn media_proxy_rejects_private_and_forged_hosts() {
    for raw in ["http://127.0.0.1/secrets", "http://192.168.50.1", "http://[::1]", "https://coolapk.com.evil.test/x", "https://evilcoolapk.com/x", "file:///etc/passwd", "https://image.coolapk.com:16601/x", "https://user:secret@image.coolapk.com/x"] { assert!(validate_media_url(raw).is_err(), "{raw}"); }
    for raw in ["https://image.coolapk.com/a.jpg", "http://avatar.coolapk.com/a.jpg", "https://f.video.weibocdn.com/a.mp4"] { assert!(validate_media_url(raw).is_ok(), "{raw}"); }
}

#[test]
fn arguments_support_camel_case_and_do_not_echo_sensitive_values() {
    assert_eq!(arg::<String>(&json!({"feedId":"12"}), "feedId", "feed_id", false).unwrap(), "12");
    assert_eq!(arg::<String>(&json!({"feed_id":"13"}), "feedId", "feed_id", false).unwrap(), "13");
    assert_eq!(arg::<Option<String>>(&json!({}), "postToken", "post_token", true).unwrap(), None);
    assert!(arg::<u32>(&json!({"page":"SECRET"}), "page", "page", false).unwrap_err().contains("page"));
    assert!(!arg::<u32>(&json!({"page":"SECRET"}), "page", "page", false).unwrap_err().contains("SECRET"));
    assert_eq!(redact_secrets(json!({"data":{"uid":"123","token":"secret","nested":{"cookie":"secret"}}})), json!({"data":{"uid":"123","nested":{}}}));
}

#[tokio::test]
async fn file_routes_cannot_read_account_directory() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    tokio::fs::write(state.data_dir.join("exports/report.json"), b"{}").await.unwrap();
    assert_eq!(call(&router, "GET", "/api/files/exports/report.json", Some(&access), json!({})).await.status(), StatusCode::OK);
    assert_eq!(call(&router, "GET", "/api/files/accounts/accounts.json", Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(call(&router, "GET", "/api/files/downloads/../settings/access.json", Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
}

#[cfg(unix)]
#[tokio::test]
async fn file_route_rejects_symlink_escape() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    std::os::unix::fs::symlink(state.data_dir.join("settings/access.json"), state.data_dir.join("exports/leaked.json")).unwrap();
    assert_eq!(call(&router, "GET", "/api/files/exports/leaked.json", Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unknown_commands_and_invalid_arguments_fail_without_network_requests() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    assert_eq!(call(&router, "POST", "/api/invoke/not_a_command", Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(call(&router, "POST", "/api/invoke/get_feed_detail", Some(&access), json!({})).await.status(), StatusCode::BAD_REQUEST);
    assert!(dispatch_generated::COMMANDS.contains(&"get_index_v8_feeds"));
    assert!(dispatch_generated::COMMANDS.contains(&"reply_feed"));
    assert!(dispatch_generated::COMMANDS.contains(&"send_private_message"));
    assert!(dispatch_generated::COMMANDS.contains(&"start_apk_download"));
    assert!(state.client.list_accounts().await.unwrap()["data"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn favorite_export_preserves_directory_names_images_and_browser_downloads() {
    let (_temp, state, router) = fixture().await;
    let access = setup(&router).await;
    let result = response_json(call(&router, "POST", "/api/invoke/create_export_directory", Some(&access), json!({"directoryName":"favorite-test","dir":""})).await).await;
    let directory = result.as_str().unwrap();
    assert!(directory.ends_with("favorite-test"));
    let image_dir = Path::new(directory).join("images");
    let response = call(&router, "POST", "/api/invoke/save_image", Some(&access), json!({"url":"data:image/png;base64,iVBORw0KGgo=", "dir":image_dir.to_string_lossy()})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let image = response_json(response).await;
    assert!(Path::new(image.as_str().unwrap()).is_file());
    assert!(image.as_str().unwrap().ends_with(".png"));
    let response = call(&router, "POST", "/api/invoke/export_json_file", Some(&access), json!({"fileName":"collection.json","content":"{}","dir":directory})).await;
    assert_eq!(response.status(), StatusCode::OK);
    let listing = response_json(call(&router, "GET", "/api/files", Some(&access), json!({})).await).await;
    assert_eq!(listing["files"].as_array().unwrap().len(), 2);
    assert!(listing["files"].as_array().unwrap().iter().any(|file| file["path"].as_str().unwrap().starts_with("exports/favorite-test/images/")));
    assert!(export_directory(&state, Some("/etc")).is_err());
    assert!(export_directory(&state, Some(&format!("{directory}/../escape"))).is_err());
}

#[tokio::test]
async fn concurrent_exports_never_overwrite_each_other() {
    let (_temp, state, _router) = fixture().await;
    let directory = state.data_dir.join("exports");
    let (first, second) = tokio::join!(save_export_bytes(&directory, "report.json", b"first"), save_export_bytes(&directory, "report.json", b"second"));
    let first = first.unwrap();
    let second = second.unwrap();
    assert_ne!(first, second);
    assert_eq!(tokio::fs::read(first).await.unwrap(), b"first");
    assert_eq!(tokio::fs::read(second).await.unwrap(), b"second");
}
