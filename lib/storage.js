'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const collections = ['emails', 'proxies', 'cards', 'licenses', 'records'];

function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('数据文件格式不正确');
  const result = { counters: {}, documents: {} };
  for (const key of collections) {
    if (!Array.isArray(value[key])) throw new Error(`数据文件缺少 ${key} 列表`);
    const ids = new Set();
    for (const row of value[key]) {
      if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id)) {
        throw new Error(`${key} 存在无效或重复编号`);
      }
      ids.add(row.id);
    }
    result[key] = structuredClone(value[key]);
    const savedCounter = value.counters?.[key];
    result.counters[key] = Number.isSafeInteger(savedCounter) && savedCounter >= 0 ? savedCounter : 0;
    for (const id of ids) result.counters[key] = Math.max(result.counters[key], id);
  }
  if (value.documents !== undefined && (!value.documents || typeof value.documents !== 'object' || Array.isArray(value.documents))) throw new Error('PDF 附件列表格式不正确');
  for (const [id, document] of Object.entries(value.documents || {})) {
    if (!/^[a-f0-9]{64}$/.test(id) || !document || typeof document.base64 !== 'string' || document.base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(document.base64)) throw new Error('PDF 附件格式不正确');
    const bytes = Buffer.from(document.base64, 'base64');
    if (bytes.length > 10 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || crypto.createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('PDF 附件校验失败');
    result.documents[id] = { filename: path.basename(String(document.filename || '营业执照.pdf')).replace(/[\\/\r\n]/g, '_'), base64: document.base64 };
  }
  for (const license of result.licenses) {
    if (license.document_id && !result.documents[license.document_id]) throw new Error(`营业执照 ${license.id} 的原 PDF 缺失`);
  }
  const fingerprints = new Set();
  const resourceMaps = Object.fromEntries(['emails', 'proxies', 'cards', 'licenses'].map((key) => [key, new Map(result[key].map((row) => [row.id, row]))]));
  const assigned = { emails: new Set(), cards: new Set(), licenses: new Set() };
  for (const record of result.records) {
    if (record.fingerprint) {
      if (typeof record.fingerprint !== 'string' || fingerprints.has(record.fingerprint)) throw new Error('备份存在无效或重复指纹名称');
      fingerprints.add(record.fingerprint);
    }
    for (const [prefix, key] of Object.entries({ email: 'emails', proxy: 'proxies', card: 'cards', license: 'licenses' })) {
      const id = record[`${prefix}_id`];
      if (id === undefined || id === null) continue;
      if (!Number.isSafeInteger(id) || !resourceMaps[key].has(id)) throw new Error(`记录 ${record.id} 关联的 ${key} 资源不存在`);
      if (assigned[key]?.has(id)) throw new Error(`${key} 资源 ${id} 被多条记录占用`);
      assigned[key]?.add(id);
      // Older backups may have incorrectly marked linked resources as available.
      const resource = resourceMaps[key].get(id);
      if (resource.status !== '停用') resource.status = '已使用';
    }
  }
  return result;
}

function createStorage(filename) {
  const directory = path.dirname(filename);
  const backupDirectory = path.join(directory, 'backups');
  return {
    load(fallback) {
      if (!fs.existsSync(filename)) return fallback;
      // Never silently replace damaged user data with a new empty database.
      return validateSnapshot(JSON.parse(fs.readFileSync(filename, 'utf8')));
    },
    save(data) {
      const body = JSON.stringify(validateSnapshot(data), null, 2);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' });
        const fd = fs.openSync(temporary, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (fs.existsSync(filename)) {
          fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
          const backup = path.join(backupDirectory, `${Date.now()}-${crypto.randomUUID()}.json`);
          fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(backup, 0o600);
        }
        fs.renameSync(temporary, filename);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      // Cleanup must not turn a committed write into an apparent failed write.
      try {
        const files = fs.readdirSync(backupDirectory).filter((f) => /^\d+-[\da-f-]+\.json$/.test(f)).sort();
        for (const file of files.slice(0, -30)) fs.unlinkSync(path.join(backupDirectory, file));
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('旧备份清理失败，当前保存已完成');
      }
    },
  };
}

module.exports = { createStorage, validateSnapshot };
