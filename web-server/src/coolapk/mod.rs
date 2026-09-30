// The web service shares the upstream protocol implementation without linking Tauri.
#[path = "../../../src-tauri/src/coolapk/auth.rs"]
pub mod auth;
#[path = "client_generated.rs"]
pub mod client;
