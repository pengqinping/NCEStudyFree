/**
 * 课程内容门面：PackManager 的薄封装，供 app.js 的路由 ctx 使用。
 * 视图只依赖这里的 async API，不感知"内置包 / 已安装包"差异。
 */

import { PackManager } from './pack-manager.js';
import { createPackStorage } from './pack-storage.js';

export const APP_VERSION = '0.3.0';

export class CourseProvider {
  constructor({ packs, appVersion = APP_VERSION } = {}) {
    this.packs = packs;
    this.appVersion = appVersion;
  }

  /** 创建并初始化默认实例（浏览器环境）。 */
  static async create({ onWarn = () => {} } = {}) {
    const storage = await createPackStorage({ onWarn });
    const packs = new PackManager({ storage, appVersion: APP_VERSION });
    const provider = new CourseProvider({ packs });
    await packs.init();
    return provider;
  }

  // ---------- 与旧 ctx API 对齐 ----------

  /** 单册数据（含单元摘要列表）。 */
  async ensureBookData(bookId) {
    return this.packs.loadBook(bookId);
  }

  /** 完整单元数据（按需加载，含课文/词汇/语法/练习）。 */
  async loadUnit(bookId, unitId) {
    return this.packs.loadUnit(bookId, unitId);
  }

  /** 同步缓存读取。 */
  getBookMeta(bookId) {
    return this.packs.getBookMeta(bookId);
  }

  getBookUnits(bookId) {
    return this.packs.getBookUnits(bookId);
  }

  getUnit(bookId, unitId) {
    return this.packs.getUnit(bookId, unitId);
  }

  async listBooks() {
    return this.packs.listBooks();
  }

  async ensureSearchIndex() {
    return this.packs.loadSearchIndex();
  }

  subscribe(listener) {
    return this.packs.subscribe(listener);
  }
}
