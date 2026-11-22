# tauri-plugin-nce-tts

NCE StudyFree 的原生 TTS 插件（仅 Android 使用）：桥接系统 `TextToSpeech`，
供 `js/tts.js` 的 `NativeTtsBackend` 调用。

## 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `plugin:nce-tts\|voices` | — | `[{ name, lang }]` |
| `plugin:nce-tts\|speak` | `{ text, rate, voiceName }` | void（状态走事件） |
| `plugin:nce-tts\|stop` | — | void |

事件 `nce-tts://state`：`{ phase: "start" \| "end" \| "error", message?, generation }`

## 接入步骤

1. `cargo tauri android init` 生成 `src-tauri/gen/android`
2. 把本插件并入工程：
   - `src-tauri/Cargo.toml`：`tauri-plugin-nce-tts = { path = "plugins/nce-tts" }`
   - `src-tauri/src/lib.rs`：`.plugin(tauri_plugin_nce_tts::init())`
   - `gen/android/settings.gradle` 追加本插件的 android 工程
3. 权限：`AndroidManifest.xml` 无需额外权限（系统 TTS 不需要联网/麦克风）
4. 验证：打开课程页点任意句子，应听到系统语音（先确认系统已安装英文语音包）
