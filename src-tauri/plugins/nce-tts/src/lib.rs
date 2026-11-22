//! nce-tts：Android 原生 TextToSpeech 桥。
//!
//! 命令（前端经 `plugin:nce-tts|voices|speak|stop` 调用）：
//!   - voices() -> [{ name, lang }]
//!   - speak(text, rate, voiceName)
//!   - stop()
//! 状态经事件 `nce-tts://state` 回报：{ phase: "start" | "end" | "error", message? }
//!
//! Android 端命令直接路由到 Kotlin `TtsPlugin`（见 mobile.rs 注册）；
//! 桌面端命令一律返回不可用（macOS 走 WKWebView 的 Web Speech API）。
//!
//! 注意：以 `cargo tauri android init` 后官方 plugins-workspace 模板为准，
//! 若 `register_android_plugin` 签名有版本差异，参照官方 notification 插件对齐。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod commands;

#[cfg(target_os = "android")]
mod mobile;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("nce-tts")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            mobile::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::voices,
            commands::speak,
            commands::stop,
        ])
        .build()
}
