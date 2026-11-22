//! Android 端插件注册：把 Kotlin 侧 `TtsPlugin` 挂到 WebView 运行时。
//! 命令随后由 Tauri IPC 直接路由到 Kotlin @Command 方法（不经过 Rust 命令体）。

use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<(), Box<dyn std::error::Error>> {
    // 插件类全名需与 android/src/main/java 下的包名一致
    api.register_android_plugin("com.cencyzp.ncestudyfree.tts", "TtsPlugin")?;
    Ok(())
}
