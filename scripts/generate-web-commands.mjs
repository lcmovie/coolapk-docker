import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'src-tauri/src/coolapk/commands.rs'), 'utf8').replace(/\r\n/g, '\n');
const outDir = path.join(root, 'web-server/src');
// Desktop uses its own networking policy. The NAS version hardens every fresh
// client before a helper can follow a public URL redirect into the LAN.
const clientSource = fs.readFileSync(path.join(root, 'src-tauri/src/coolapk/client.rs'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\b(?:reqwest::)?Client::builder\(\)/g, match => `${match}.redirect(crate::secure_redirect_policy()).timeout(std::time::Duration::from_secs(45))`)
  .replace(/(let oss_url = format!\([^\n]+\);)/g, '$1\n        crate::uploads::validate_oss_upload_url(&oss_url)?;')
  .replace('let url = format!("https://{bucket}.{host}/{key}");', 'let url = format!("https://{bucket}.{host}/{key}");\n        crate::uploads::validate_oss_upload_url(&url)?;')
  .replace('.client\n            .request(reqwest::Method::PUT, &oss_url)', '.redirect_client\n            .request(reqwest::Method::PUT, &oss_url)\n            .timeout(std::time::Duration::from_secs(600))')
  .replace('self.client.put(url).header("Authorization"', 'self.redirect_client.put(url).timeout(std::time::Duration::from_secs(600)).header("Authorization"')
  .replace('return Err(format!("OSS 直传失败 (HTTP {}): {}", oss_status, &oss_body));', 'return Err(format!("OSS 直传失败 (HTTP {})", oss_status));')
  .replace('Err(format!("OSS 直传响应异常: {}", &oss_body))', 'Err("OSS 直传响应异常".to_string())')
  .replace('let oss_res = oss_request.send().await.map_err(|e| e.to_string())?;', 'let oss_res = oss_request.send().await.map_err(|_| "OSS 图片上传连接失败，结果未知，请先确认是否已完成".to_string())?;')
  .replace('.map_err(|error| format!("上传到酷安 CDN 失败：{error}"))?', '.map_err(|_| "上传到酷安 CDN 连接失败，结果未知，请先确认是否已完成".to_string())?')
  .replace('.body(bytes.to_vec()).send().await.map_err(|error| error.to_string())?', '.body(bytes.to_vec()).send().await.map_err(|_| "OSS 视频上传连接失败，结果未知，请先确认是否已完成".to_string())?')
  .replace('let _ = std::fs::write(&path, json);', 'if crate::write_accounts_atomic(&path, json.as_bytes()).is_err() { log::error!("accounts.persistence_failed"); }')
  .replace('#[path = "client_tests.rs"]', '#[path = "../../../src-tauri/src/coolapk/client_tests.rs"]')
  .replace('#[path = "api_tests.rs"]', '#[path = "../../../src-tauri/src/coolapk/api_tests.rs"]')
  .replace('.redirect_client\n            .put(&oss_url)', '.redirect_client\n            .put(&oss_url)\n            .timeout(std::time::Duration::from_secs(3600))')
  .replace('impl CoolapkClient {', `impl CoolapkClient {
    // Long uploads own an identity snapshot and do not block account switching.
    pub(crate) fn web_snapshot(&self) -> Result<Self, String> {
        let code = self.device_code.read().map_err(|_| "无法读取设备信息")?.clone();
        Ok(Self {
            client: self.client.clone(), redirect_client: self.redirect_client.clone(),
            auth: RwLock::new(CoolapkAuth::new(code.clone())),
            user_cookie: RwLock::new(self.user_cookie.read().map_err(|_| "无法读取账户信息")?.clone()),
            cookie_file: RwLock::new(None),
            device_profile: RwLock::new(self.device_profile.read().map_err(|_| "无法读取设备信息")?.clone()),
            device_code: RwLock::new(code),
        })
    }
`);
fs.writeFileSync(path.join(outDir, 'coolapk/client_generated.rs'), '// Generated from upstream client.rs by scripts/generate-web-commands.mjs.\n' + clientSource);

// Rust command bodies only use normal string literals. Skip literals and comments
// while finding their braces so a brace in a URL/template cannot end a function.
function bodyEnd(start) {
  let depth = 0, mode = '', escape = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (mode === 'line') { if (c === '\n') mode = ''; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = ''; i++; } continue; }
    if (mode === 'string') {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') mode = '';
      continue;
    }
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === '"') { mode = 'string'; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i + 1;
  }
  throw new Error('Unbalanced Rust function body');
}

const custom = new Set(['check_login_status', 'check_login_info', 'save_cookie_securely', 'get_user_cookie', 'fetch_external_page', 'update_device_profile', 'upload_file_to_cdn', 'cancel_cdn_upload', 'take_update_install_error']);
const copied = [];
const commandPattern = /#\[tauri::command\][\s\S]*?pub (async )?fn (\w+)\s*\(/g;
for (const match of source.matchAll(commandPattern)) {
  const name = match[2];
  const fnStart = source.indexOf('pub ', match.index);
  const brace = source.indexOf('{', fnStart);
  const signature = source.slice(fnStart, brace);
  const body = source.slice(brace, bodyEnd(brace));
  if (custom.has(name) || !signature.includes("State<'_, AppState>") || signature.includes('tauri::AppHandle') || body.includes('state.downloads') || body.includes('tauri::')) continue;
  copied.push({ name, async: !!match[1], signature: signature.replace(/State<'_, AppState>/g, '&AppState'), body });
}

const header = '// Generated by scripts/generate-web-commands.mjs. Do not edit by hand.\n';
const wrappers = header + 'use crate::AppState;\nuse crate::coolapk::client::DeviceProfile;\nuse serde_json::{Value, json};\n\n' + copied.map(x => `${x.signature}${x.body}\n`).join('\n');
fs.writeFileSync(path.join(outDir, 'commands_generated.rs'), wrappers);

// Reuse the upstream APK download state machine (validation, Range resume,
// pause/cancel and downloadVerify) while replacing only its desktop event sink.
let download = source.slice(source.indexOf('const APK_DOWNLOAD_MAX_BYTES:'), source.indexOf('#[tauri::command]\npub async fn get_apk_qr') > 0 ? source.indexOf('#[tauri::command]\npub async fn get_apk_qr') : source.indexOf('#[tauri::command]\r\npub async fn get_apk_qr'));
if (!download) throw new Error('Cannot locate upstream APK download implementation');
download = download.replace(/#\[tauri::command\]\s*/g, '')
  .replace(/State<'_, AppState>/g, '&AppState')
  .replace(/&tauri::AppHandle/g, '&AppState')
  .replace(/tauri::AppHandle/g, '&AppState')
  .replace(/\s*use tauri::Emitter;/g, '')
  .replace('.redirect(reqwest::redirect::Policy::limited(10))', '.redirect(crate::secure_redirect_policy()).connect_timeout(std::time::Duration::from_secs(20)).read_timeout(std::time::Duration::from_secs(60))')
  .replace('use tokio::io::AsyncWriteExt;', 'use tokio::io::AsyncWriteExt;\n    let _identity = tokio::time::timeout(std::time::Duration::from_secs(15), app.account_gate.read()).await.map_err(|_| "账户正在切换，请稍后重试下载".to_string())?;')
  .replace('.header(ACCEPT_ENCODING, "identity");', '.header(ACCEPT_ENCODING, "identity");\n    // Request headers hold a credential snapshot; permit account switching while streaming.\n    drop(_identity);')
  .replace('    open_local_path(&app, &target_dir).await?;\n', '')
  .replace(/opener::open\(&target_dir\)[\s\S]*?;\s*Ok\(\(\)\)/, 'Ok(())');
fs.writeFileSync(path.join(outDir, 'downloads_generated.rs'), header + 'use crate::{AppState, user_save_dir, validate_custom_dir, next_available_file_path};\nuse crate::coolapk::client::CoolapkClient;\nuse crate::download_manager::DownloadControl;\nuse base64::{Engine as _, engine::general_purpose::{STANDARD as BASE64, STANDARD_NO_PAD as BASE64_NO_PAD}};\nuse serde_json::{Value, json};\nuse std::path::{Path, PathBuf};\nuse std::time::Instant;\n\n' + download.trimEnd() + '\n');

const downloads = ['start_apk_download', 'pause_apk_download', 'cancel_apk_download', 'delete_apk_download_file', 'open_apk_download_directory'];
const all = [...copied];
for (const name of downloads) {
  const p = download.search(new RegExp(`pub (?:async )?fn ${name}\\(`));
  if (p < 0) throw new Error(`Cannot find download command ${name}`);
  const signature = download.slice(p, download.indexOf('{', p));
  all.push({ name, async: signature.includes('pub async'), signature, download: true });
}
const camel = name => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const arms = all.map(x => {
  const params = x.signature.slice(x.signature.indexOf('(') + 1, x.signature.lastIndexOf(') ->')).split(',').map(x => x.trim()).filter(Boolean).map(param => {
    const colon = param.indexOf(':');
    if (colon < 0) throw new Error(`Bad Rust parameter ${param}`);
    return { name: param.slice(0, colon).trim(), type: param.slice(colon + 1).trim() };
  });
  const args = params.filter(p => p.type !== '&AppState');
  const declarations = args.map(p => `            let ${p.name}: ${p.type} = arg(args, "${camel(p.name)}", "${p.name}", ${p.type.startsWith('Option<')})?;`).join('\n');
  const invocation = `${x.download ? 'downloads_generated' : 'commands_generated'}::${x.name}(${params.map(p => p.type === '&AppState' ? 'state' : p.name).join(', ')})${x.async ? '.await' : ''}?`;
  return `        "${x.name}" => {\n${declarations}\n            serde_json::to_value(${invocation}).map_err(|e| e.to_string())\n        },`;
}).join('\n');
fs.writeFileSync(path.join(outDir, 'dispatch_generated.rs'), header + `use crate::{AppState, arg, commands_generated, downloads_generated};\nuse crate::coolapk::client::DeviceProfile;\nuse serde_json::Value;\n\npub const COMMANDS: &[&str] = &${JSON.stringify(all.map(x => x.name)).replaceAll('"', '"')};\n\npub async fn dispatch(state: &AppState, command: &str, args: &Value) -> Result<Value, String> {\n    match command {\n${arms}\n        _ => Err(format!("不支持的网页命令：{command}")),\n    }\n}\n`);
fs.writeFileSync(path.join(root, 'web-server/commands.json'), JSON.stringify({ businessCommands: copied.map(x => x.name), downloadCommands: downloads, customCommands: [...custom] }, null, 2) + '\n');
console.log(`Generated ${copied.length} business commands and ${downloads.length} download commands.`);
