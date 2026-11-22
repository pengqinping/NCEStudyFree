/**
 * 已安装资源包的存储适配器（Tauri 壳：macOS / Android）。
 *
 * 通过壳的自定义命令 pack_* 直接读写应用数据目录：
 *   macOS   ~/Library/Application Support/<identifier>/packs/
 *   Android 应用内部存储/files/<identifier>/packs/
 * 不依赖 WebView 的 IndexedDB，避免被系统/用户清理。
 */

export function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function invoke(command, args = {}) {
  return window.__TAURI_INTERNALS__.invoke(command, args);
}

export class TauriPackStorage {
  constructor() {
    this.rootPromise = null;
  }

  async #root() {
    if (!this.rootPromise) {
      this.rootPromise = invoke('pack_root_dir');
    }
    return this.rootPromise;
  }

  async putFile(packId, path, text) {
    await invoke('pack_write_file', { rel: `${packId}/${path}`, contents: String(text) });
  }

  async getFile(packId, path) {
    const text = await invoke('pack_read_file', { rel: `${packId}/${path}` });
    return typeof text === 'string' ? text : null;
  }

  async deletePack(packId) {
    await invoke('pack_remove', { packId });
  }

  async listPackFiles(packId) {
    const files = (await invoke('pack_list_files')) || [];
    const prefix = `${packId}/`;
    return files
      .filter((file) => typeof file === 'string' && file.startsWith(prefix))
      .map((file) => file.slice(prefix.length));
  }
}
