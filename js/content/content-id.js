/**
 * 内容稳定 ID：学习进度以 contentId 为键，与资源包版本解耦。
 *
 * 旧版课号 `b1-u01`（第 1 册第 1 个学习单元）与新版 `nce1:u01` 语义一致，
 * 只是加了书系命名空间，便于未来接入其他教材资源包。
 * SRS 卡 ID（`b1-u01:word`）与错题 ID（`b1-u01-q01`）包含课号前缀，同样可映射。
 */

const LEGACY_UNIT_RE = /^b(\d+)-u(\d+)(.*)$/;

/** 旧课号 → 稳定内容 ID；已是稳定 ID 或其他字符串则原样返回。 */
export function toContentId(id) {
  if (typeof id !== 'string') return id;
  const match = id.match(LEGACY_UNIT_RE);
  if (!match) return id;
  return `nce${match[1]}:u${match[2]}${match[3]}`;
}

/** 由教材 key（如 NCE1）与单元序号生成稳定内容 ID。 */
export function unitContentId(bookKey, unitNumber) {
  const bookId = String(bookKey || '').replace(/^NCE/i, '');
  const unit = String(unitNumber).padStart(2, '0');
  return `nce${bookId}:u${unit}`;
}

/** 稳定内容 ID → 单元数据文件名（u01.json）。 */
export function unitFileName(contentId) {
  const match = String(contentId).match(/:u(\d+)$/);
  if (!match) return null;
  return `u${match[1].padStart(2, '0')}.json`;
}

const UNIT_ID_RE = /^([a-z]+)(\d+):u(\d+)$/i;

/**
 * 从稳定内容 ID 提取 { bookNumber, unitNumber }，用于兼容旧路由 `#/lesson/b1-u01`。
 * 非稳定 ID 返回 null。
 */
export function parseContentId(contentId) {
  const match = String(contentId || '').match(UNIT_ID_RE);
  if (!match) return null;
  return {
    key: `NCE${match[2]}`,
    bookNumber: Number(match[2]),
    unitNumber: Number(match[3]),
  };
}
