//! 桌面端命令占位实现（Android 上这些命令由 Kotlin `TtsPlugin` 的 @Command 直接承接）。

use serde_json::Value;
use tauri::command;

#[command]
pub async fn voices() -> Result<Value, String> {
    Err("原生 TTS 仅在 Android 壳中可用（桌面/Web 走 Web Speech API）".into())
}

#[command]
pub async fn speak(_text: String, _rate: f64, _voice_name: String) -> Result<(), String> {
    Err("原生 TTS 仅在 Android 壳中可用（桌面/Web 走 Web Speech API）".into())
}

#[command]
pub async fn stop() -> Result<(), String> {
    Err("原生 TTS 仅在 Android 壳中可用（桌面/Web 走 Web Speech API）".into())
}
