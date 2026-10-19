'use strict';
// Personal JSON backups embed base64 PDF bytes inside an encrypted base64 envelope.
// Keep the exported envelope within the existing restore endpoint's budget.
// Large workspaces use the independently verified streaming server backup path;
// this guard is NOT a chunked personal-backup implementation.
const RESTORE_BODY_LIMIT = 64 * 1024 * 1024;
const ENVELOPE_RESERVE = 4096;
const MAX_ENVELOPE_BYTES = RESTORE_BODY_LIMIT - ENVELOPE_RESERVE;
function tooLarge() {
  const error = new Error('个人备份超过当前可恢复的大小上限，已取消导出。请联系管理员使用服务器加密全库备份；现有数据未改变。');
  error.statusCode = 409;
  error.code = 'PERSONAL_BACKUP_TOO_LARGE';
  return error;
}
function assertDocumentBudget(db, ownerId) {
  const rows = db.prepare('SELECT size FROM documents WHERE sha256 IN (SELECT document_id FROM licenses WHERE owner_id=? AND document_id IS NOT NULL)').all(ownerId);
  let innerBase64Bytes = 0;
  for (const row of rows) {
    innerBase64Bytes += 4 * Math.ceil(Number(row.size) / 3);
    // Even without any JSON metadata the second base64 layer cannot fit.
    if (4 * Math.ceil(innerBase64Bytes / 3) > MAX_ENVELOPE_BYTES) throw tooLarge();
  }
}
function assertEnvelopeBudget(envelope) {
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_ENVELOPE_BYTES) throw tooLarge();
  return envelope;
}
module.exports = {RESTORE_BODY_LIMIT, MAX_ENVELOPE_BYTES, assertDocumentBudget, assertEnvelopeBudget};
