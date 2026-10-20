'use strict';
const store = require('./store');
const { decodeRow, SECRET_FIELDS } = require('./vault');
const { LINKS, SNAP } = require('./resource-snapshots');
const { audit } = require('./hardening');

const columns = ['id', 'owner_id', 'version', 'fingerprint', 'domain', ...Object.entries(LINKS).flatMap(([prefix, link]) => [`${prefix}_id`, ...Object.keys(link.fields)])];
const fail = (statusCode, message) => { const error = new Error(message); error.statusCode = statusCode; throw error; };
const preview = value => { const text = String(value ?? ''); return text.length > 256 ? text.slice(0, 256) + '…（已截断）' : text; };
const differences = (record, prefix, resource) => Object.entries(LINKS[prefix].fields).filter(([field, [source]]) => String(record[field] ?? '') !== String(resource[source] ?? '')).map(([field, [, label]]) => ({
  field, label, sensitive: SECRET_FIELDS.has(field),
  before: SECRET_FIELDS.has(field) ? '已隐藏（值不同）' : preview(record[field]),
  after: SECRET_FIELDS.has(field) ? '已隐藏（以关联资源为准）' : preview(SNAP[prefix](resource)[field]),
}));
const resourceLabel = (prefix, item) => preview(prefix === 'email' ? item.user : prefix === 'proxy' ? `${item.host}:${item.port}` : prefix === 'card' ? item.number : item.name);

/** Read one bounded keyset batch. No writes, PDF reads, matching by name or reassignment. */
function scanPage(db, ownerId, { after = 0, upperBound, limit = 100 } = {}) {
  const ceiling = upperBound ?? Number(db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM records WHERE owner_id=?').get(ownerId).n);
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM records WHERE owner_id=? AND id<=?').get(ownerId, ceiling).n);
  const rows = db.prepare(`SELECT ${columns.join(',')} FROM records WHERE owner_id=? AND id>? AND id<=? ORDER BY id LIMIT ?`).all(ownerId, after, ceiling, limit + 1);
  const more = rows.length > limit;
  const batch = rows.slice(0, limit);
  const cache = new Map();
  const findings = [];
  for (const row of batch) {
    const record = decodeRow(db, 'records', row);
    const issues = [];
    for (const [prefix, link] of Object.entries(LINKS)) {
      const id = record[`${prefix}_id`];
      const validId = Number.isSafeInteger(id) && id > 0;
      const base = { prefix, kind: link.kind, label: link.label, resource_id: validId ? id : null };
      if (id == null) {
        if (Object.keys(link.fields).some(field => record[field])) issues.push({ ...base, code: 'unlinked_snapshot', message: '有独立快照但没有关联，可能是历史录入；需人工核对', repairable: false });
        continue;
      }
      if (!validId) {
        issues.push({ ...base, code: 'invalid_reference', message: '历史关联编号格式无效，需人工重新选择资源', repairable: false });
        continue;
      }
      const key = `${prefix}:${id}`;
      if (!cache.has(key)) {
        const resource = store.findPoolItem(db, ownerId, link.kind, id);
        const usage = resource ? Number(db.prepare(`SELECT COUNT(*) AS n FROM records WHERE owner_id=? AND ${prefix}_id=?`).get(ownerId, id).n) : 0;
        cache.set(key, { resource, usage });
      }
      const { resource, usage } = cache.get(key);
      if (!resource) {
        issues.push({ ...base, code: 'missing_resource', message: '当前关联在本人资源库中不可用，需重新选择或清空关联', repairable: false });
        continue;
      }
      const current = { ...base, resource_version: resource.version, resource_label: resourceLabel(prefix, resource), usage };
      const fields = differences(record, prefix, resource);
      if (fields.length) issues.push({ ...current, code: 'snapshot_mismatch', message: '记录快照与当前关联资源不一致', fields, repairable: true, action: 'sync_snapshot' });
      if (link.exclusive && usage > 1) issues.push({ ...current, code: 'duplicate_usage', message: `同一资源关联了 ${usage} 条本人记录，需人工决定各条记录的资源`, repairable: false });
      if (resource.status === '未使用') issues.push({ ...current, code: 'usage_status', message: '已有记录关联，但资源仍标记为未使用', repairable: true, action: 'mark_used', fields: [{ label: '资源状态', before: '未使用', after: '已使用', sensitive: false }] });
    }
    if (issues.length) findings.push({ id: record.id, version: record.version, fingerprint: record.fingerprint, domain: record.domain, issues });
  }
  return { findings, checked: batch.length, total, upper_bound: ceiling, next_after: more ? batch.at(-1).id : null, has_more: more };
}

/** Caller wraps this and its audit in a transaction. Never changes relation IDs. */
function applyRepair(db, ownerId, body) {
  const allowed = new Set(['action', 'prefix', 'record_id', 'record_version', 'resource_id', 'resource_version']);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) fail(400, '修复请求字段无效');
  if (!Object.hasOwn(LINKS, body.prefix) || !['sync_snapshot', 'mark_used'].includes(body.action)) fail(400, '修复类型无效');
  for (const field of ['record_id', 'resource_id']) if (!Number.isSafeInteger(body[field]) || body[field] < 1) fail(400, '记录或资源编号无效');
  for (const field of ['record_version', 'resource_version']) if (!Number.isSafeInteger(body[field]) || body[field] < 0) fail(428, '必须提供检查时的记录和资源版本，请重新检查');
  const row = db.prepare(`SELECT ${columns.join(',')} FROM records WHERE owner_id=? AND id=?`).get(ownerId, body.record_id);
  if (!row) fail(404, '记录或关联资源不可用，请重新检查');
  if (row.version !== body.record_version || row[`${body.prefix}_id`] !== body.resource_id) fail(409, '记录或关联已变化，请重新检查后核对');
  const link = LINKS[body.prefix];
  const resource = store.findPoolItem(db, ownerId, link.kind, body.resource_id);
  if (!resource) fail(404, '记录或关联资源不可用，请重新检查');
  if (resource.version !== body.resource_version) fail(409, '资源已变化，请重新检查后核对');
  const record = decodeRow(db, 'records', row);
  if (body.action === 'sync_snapshot') {
    if (!differences(record, body.prefix, resource).length) return { changed: false };
    store.updateRecordColumns(db, ownerId, record.id, Object.fromEntries(Object.entries(SNAP[body.prefix](resource)).map(([field, value]) => [field, value ?? ''])));
  } else {
    if (resource.status !== '未使用' || !db.prepare(`SELECT 1 FROM records WHERE owner_id=? AND ${body.prefix}_id=? LIMIT 1`).get(ownerId, resource.id)) fail(409, '资源状态或占用已变化，请重新检查');
    store.setPoolStatus(db, ownerId, link.kind, resource.id, '已使用');
  }
  audit(db, ownerId, 'records.integrity.repair', `${body.action}:${body.prefix}:record:${record.id}:resource:${resource.id}`);
  return { changed: true, action: body.action, record_id: record.id };
}
module.exports = { scanPage, applyRepair };
