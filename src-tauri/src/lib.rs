//! NCE StudyFree 跨端壳。
//!
//! Web 内核（仓库根目录的纯静态站点）由系统 WebView 承载：
//!   - macOS：WKWebView（Web Speech API 可用，无需原生 TTS）
//!   - Android：System WebView（无 speechSynthesis，由 nce-tts 插件提供系统 TextToSpeech）
//!
//! 资源包持久化：自定义 pack_* 命令直接读写应用数据目录
//! （macOS: ~/Library/Application Support；Android: 应用内部存储），
//! 不依赖 WebView 的 IndexedDB，避免被系统清理。
//!
//! 首次运行前：
//!   1. 安装 Rust 与 Tauri CLI（`cargo install tauri-cli --version "^2"`）
//!   2. `cargo tauri icon assets/icons/icon-512.png` 生成 icons/
//!   3. `cargo tauri dev`（桌面）或 `cargo tauri android init`（移动端，见 docs/tauri.md）
//!
//! 详见 docs/tauri.md。

use std::path::{Path, PathBuf};
use tauri::Manager;

// ---------- 资源包文件存储命令 ----------
//
// 目录布局：<app_local_data_dir>/packs/<packId>/<相对路径>
// JS 侧适配器：js/content/pack-storage-tauri.js

/// 校验包内相对路径：禁绝对路径、目录穿越与反斜杠。
fn safe_rel(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("路径为空".into());
    }
    if rel.starts_with('/') || rel.contains('\\') || rel.contains('\0') {
        return Err(format!("非法路径：{rel}"));
    }
    let path = Path::new(rel);
    let has_unsafe = path
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)));
    if has_unsafe {
        return Err(format!("非法路径：{rel}"));
    }
    Ok(path.to_path_buf())
}

fn pack_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("解析应用数据目录失败：{e}"))?;
    Ok(base.join("packs"))
}

#[tauri::command]
pub fn pack_root_dir<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<String, String> {
    let dir = pack_root(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn pack_read_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    rel: String,
) -> Result<Option<String>, String> {
    let path = pack_root(&app)?.join(safe_rel(&rel)?);
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn pack_write_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    rel: String,
    contents: String,
) -> Result<(), String> {
    let path = pack_root(&app)?.join(safe_rel(&rel)?);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

fn walk_files(dir: &Path, base: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, base, out)?;
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pack_list_files<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<String>, String> {
    let root = pack_root(&app)?;
    let mut files = Vec::new();
    if root.exists() {
        walk_files(&root, &root, &mut files).map_err(|e| e.to_string())?;
    }
    Ok(files)
}

#[tauri::command]
pub fn pack_remove<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    pack_id: String,
) -> Result<(), String> {
    let valid = pack_id.len() >= 3
        && pack_id.len() <= 64
        && pack_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(format!("非法 packId：{pack_id}"));
    }
    let dir = pack_root(&app)?.join(&pack_id);
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_nce_tts::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            pack_root_dir,
            pack_read_file,
            pack_write_file,
            pack_list_files,
            pack_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
