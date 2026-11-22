#!/usr/bin/env node
/**
 * `cargo tauri android init` 之后运行：把 nce-tts 插件并入生成的 Android 工程。
 *
 * 幂等：重复运行只会追加一次；已存在的内容自动跳过。
 * 覆盖：
 *   1. gen/android/settings.gradle        —— include nce-tts 工程
 *   2. gen/android/app/build.gradle.kts   —— 依赖 ':nce-tts'
 *   3. gen/android/app/src/main/AndroidManifest.xml —— RECORD_AUDIO 权限（复习跟读用）
 *
 * 用法：node tools/android-patch.mjs [gen/android 目录，默认 src-tauri/gen/android]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ANDROID_DIR = path.resolve(ROOT, process.argv[2] || 'src-tauri/gen/android');

async function patch(file, mutate, label) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    console.warn(`跳过（未找到 ${label}）：${file}`);
    return false;
  }
  const next = mutate(text);
  if (next === text) {
    console.log(`已存在，跳过：${label}`);
    return true;
  }
  await writeFile(file, next, 'utf8');
  console.log(`已修改：${label}`);
  return true;
}

async function main() {
  const settings = path.join(ANDROID_DIR, 'settings.gradle');
  const appGradle = path.join(ANDROID_DIR, 'app', 'build.gradle.kts');
  const manifest = path.join(ANDROID_DIR, 'app', 'src', 'main', 'AndroidManifest.xml');

  const results = await Promise.all([
    patch(
      settings,
      (text) => {
        if (text.includes(":nce-tts")) return text;
        const marker = '// nce-tts plugin (added by tools/android-patch.mjs)\n'
          + "include ':nce-tts'\n"
          + "project(':nce-tts').projectDir = new File(\"$rootDir/../../../plugins/nce-tts/android\")\n";
        return `${text.replace(/\s*$/, '\n')}${marker}`;
      },
      'settings.gradle 并入 nce-tts 工程',
    ),
    patch(
      appGradle,
      (text) => {
        if (text.includes('project(":nce-tts")') || text.includes("project(':nce-tts')")) return text;
        // 插入到 dependencies 块末尾
        return text.replace(
          /dependencies\s*\{/,
          'dependencies {\n    implementation(project(":nce-tts")) // nce-tts 插件（tools/android-patch.mjs）',
        );
      },
      'app/build.gradle.kts 添加 nce-tts 依赖',
    ),
    patch(
      manifest,
      (text) => {
        if (text.includes('android.permission.RECORD_AUDIO')) return text;
        return text.replace(
          /<manifest[^>]*>/,
          (match) => `${match}\n    <!-- 复习跟读（麦克风录音）权限，加入于 tools/android-patch.mjs -->\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />`,
        );
      },
      'AndroidManifest.xml 添加 RECORD_AUDIO',
    ),
  ]);

  if (results.includes(false)) {
    console.error('\n部分文件未找到：请先运行 `cargo tauri android init`，或把 gen/android 路径作为参数传入。');
    process.exitCode = 1;
    return;
  }
  console.log('\n完成。下一步：cargo tauri android dev（真机）验证朗读与录音。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
