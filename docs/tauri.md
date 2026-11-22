# NCE StudyFree 跨端壳（Tauri 2）构建指南

架构：Web 内核（仓库根目录的纯静态站点）+ Tauri 2 壳。
三端共享同一份前端代码，差异只在存储与 TTS 适配：

| 端 | WebView | TTS | 数据持久化 |
| --- | --- | --- | --- |
| Web | 浏览器 | Web Speech API | localStorage + IndexedDB（资源包） |
| macOS | WKWebView | Web Speech API（WKWebView 可用） | 同上（WebView 配置文件内） |
| Android | System WebView | **nce-tts 插件**（系统 TextToSpeech） | 同上；后续可切 fs 后端 |

## 0. 前置条件

```bash
# Rust（含 cargo）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Tauri CLI
cargo install tauri-cli --version "^2"

# macOS 打包需要 Xcode Command Line Tools
xcode-select --install

# Android 需要 JDK 17、Android SDK（API 34）、NDK、cargo-ndk
cargo install cargo-ndk
```

> 已在仓库中就绪（无需再改）：TTS 插件已注册进 `src-tauri/Cargo.toml` 与 `lib.rs`；
> 资源包文件存储命令 `pack_*`（pack-storage-tauri.js 自动选择）；
> 窗口状态记忆（tauri-plugin-window-state）；Android minSdk 24（tauri.android.conf.json）。

## 1. 生成图标（首次必须）

```bash
cargo tauri icon assets/icons/icon-512.png
```

## 2. 桌面（macOS）

```bash
cargo tauri dev        # 开发预览（复用仓库根目录静态文件）
cargo tauri build      # 产物：src-tauri/target/release/bundle/{dmg,macos}/
```

验证清单：
- 首页/课程/课文/练习/复习/统计/搜索全流程可用
- 朗读：设置页"试听"应出声（WKWebView speechSynthesis）
- 离线：断网后重启应用仍可学习（数据打包在应用内）

## 3. Android

```bash
cargo tauri android init      # 生成 src-tauri/gen/android
```

然后把 nce-tts 插件接入工程（见 `src-tauri/plugins/nce-tts/README.md`）：

1. `src-tauri/Cargo.toml` 追加：
   ```toml
   tauri-plugin-nce-tts = { path = "plugins/nce-tts" }
   ```
2. `src-tauri/src/lib.rs` 注册：
   ```rust
   .plugin(tauri_plugin_nce_tts::init())
   ```
3. **插件与权限自动并入**（已内置，无需手动改 gradle）：
   ```bash
   node tools/android-patch.mjs
   # 幂等脚本：并入 nce-tts 工程 + 注入 RECORD_AUDIO 权限（复习跟读）
   ```

构建：

```bash
cargo tauri android dev                  # 连接真机/模拟器调试
cargo tauri android build --apk          # 产物 APK
cargo tauri android build --aab          # 上架用 AAB
```

验证清单（Android WebView 无 speechSynthesis，全部朗读必须走插件）：
- 设置页"口音"下拉能列出系统英文语音
- 课文点读/全文连读正常，停止按钮有效
- 麦克风录音（复习跟读）权限弹窗正常
- 返回键：hash 路由天然产生 WebView 历史条目，系统返回键默认回退上一路由（Tauri 默认行为，无需额外适配）

桌面端（macOS）已内置：
- `tauri-plugin-window-state`：窗口位置/大小自动记忆
- 资源包文件存储：pack_* 命令读写 `~/Library/Application Support/<identifier>/packs/`
- 可选：如需启用"复习跟读"录音，需在打包后的 Info.plist 注入
  `NSMicrophoneUsageDescription`（v2 配置不支持自定义 plist 键，可用打包后处理脚本）；
  不加也不影响其他功能

## 4. 资源包发布流（三端通用）

```bash
node tools/build-pack.mjs     # 产出 data/packs/、data/catalog.json、dist/packs/*.ncepack
```

- `data/catalog.json` 与 `dist/packs/` 随 GitHub Pages 部署后，
  三端"设置 → 课程资源包 → 检查更新"即可发现新版本
- 目录源可在"设置 → 课程资源包 → 目录地址"指向任意静态托管的 catalog.json；
  "启动时自动检查更新"默认开启（只提醒，不自动下载）
- 版本升级：改 `tools/build-pack.mjs` 中的 `PACK_VERSION` 后重新构建
- 进度安全：学习状态以 `contentId`（如 `nce1:u01`）为主键，与包版本无关

## 5. CI（GitHub Actions）

| 工作流 | 触发 | 产物 |
| --- | --- | --- |
| `ci.yml` | push/PR | 资源包构建 + 数据校验 + 42 项单测 + 产物一致性 |
| `deploy-web.yml` | push main / 手动 | GitHub Pages 部署（含最新资源包） |
| `release-desktop.yml` | `app-v*` tag / 手动 | macOS dmg（arm64 + x64 双架构） |
| `release-android.yml` | `app-v*` tag / 手动 | Android APK（arm64，自动并入 TTS 插件） |

冒烟测试（可选本地）：`npm install && SMOKE_BROWSER=chrome node tools/smoke.mjs`
（默认用 msedge，可用 SMOKE_BROWSER 覆盖；27 项端到端检查含离线/移动端/路由竞态）

## 6. 已知事项

- WebView 内 localStorage 可能被系统清理：学习进度仍有风险（历史设计），
  资源包已切换到原生文件存储（pack_* 命令）；设置页提供导出备份，
  后续可把 Store 也切到 fs/SQLite 后端（`store.js` 构造函数已支持注入 storage 实现）
- Tauri 插件模板 API 随 v2 小版本演进：`register_android_plugin` 等
  调用如编译报错，参照官方 plugins-workspace（如 notification 插件）对齐
