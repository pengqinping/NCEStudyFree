/**
 * 资源包 manifest 校验：路径安全、schema 版本、条目完整性。
 * 纯逻辑，浏览器与 Node 单测共用。
 */

export const PACK_SCHEMA_VERSION = 1;
const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** 包内相对路径必须安全：禁绝对路径、`..`、反斜杠与前后斜杠。 */
export function isSafePackPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (relPath.includes('\\') || relPath.includes('\0')) return false;
  if (relPath.startsWith('/') || relPath.endsWith('/')) return false;
  const segments = relPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return true;
}

/**
 * 校验 manifest.json。返回错误信息数组；空数组表示通过。
 * manifest 由作者可控，校验从严：任何字段缺失都拒绝安装。
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest 不是对象'];
  }
  if (manifest.schemaVersion !== PACK_SCHEMA_VERSION) {
    errors.push(`不支持的 schemaVersion：${manifest.schemaVersion}（当前支持 ${PACK_SCHEMA_VERSION}）`);
  }
  if (typeof manifest.packId !== 'string' || !PACK_ID_RE.test(manifest.packId)) {
    errors.push('packId 缺失或格式非法（小写字母数字与连字符，3-64 位）');
  }
  if (typeof manifest.version !== 'string' || !SEMVER_RE.test(manifest.version)) {
    errors.push('version 缺失或不符合 semver（如 1.0.0）');
  }
  if (!Array.isArray(manifest.books) || !manifest.books.length) {
    errors.push('books 缺失或为空');
  }
  for (const book of manifest.books || []) {
    if (!book || typeof book !== 'object') {
      errors.push('books 条目不是对象');
      continue;
    }
    if (!Number.isInteger(book.id) || book.id < 1) errors.push(`book.id 非法：${book.id}`);
    if (typeof book.key !== 'string' || !book.key) errors.push(`book(${book.id}) 缺少 key`);
    if (isSafePackPath(book.entry) === false) errors.push(`book(${book.id}) entry 路径非法：${book.entry}`);
    if (!Number.isInteger(book.units) || book.units < 1) errors.push(`book(${book.id}) units 非法`);
  }
  if (manifest.minAppVersion !== undefined && typeof manifest.minAppVersion !== 'string') {
    errors.push('minAppVersion 类型非法');
  }
  if (manifest.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(String(manifest.sha256))) {
    errors.push('sha256 格式非法');
  }
  return errors;
}

/** 校验包目录文件清单：manifest.books.entry 与单元文件路径都必须安全。 */
export function validatePackFiles(manifest, files) {
  const errors = [];
  const fileSet = new Set(files);
  for (const book of manifest.books || []) {
    if (!fileSet.has(book.entry)) errors.push(`缺少 ${book.entry}`);
    const bookDir = book.entry.split('/').slice(0, -1).join('/');
    for (const file of files) {
      if (file.startsWith(bookDir) && file !== book.entry && isSafePackPath(file) === false) {
        errors.push(`非法路径：${file}`);
      }
    }
  }
  return errors;
}

/** 比较两个 semver 版本：返回 -1 / 0 / 1。忽略 prerelease 细节，按主/次/补丁比较。 */
export function compareVersions(a, b) {
  const parse = (version) =>
    String(version || '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
}
