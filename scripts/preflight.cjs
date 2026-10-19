'use strict';
/**
 * 上线前自检（方案工作包 01 / 04 / 09 的校验脚本）。
 *
 * 在与生产**相同的环境变量**下运行：node scripts/preflight.cjs
 * 只做「不需要猜」的检查：配置是否自洽、数据库能否打开、关键防护是否开启。
 * 凡是无法从进程内确定的项，一律不冒充结论，而是打印手工确认的方法与后果。
 * 退出码非 0 表示存在必须处理的项。
 */
const fs = require('node:fs');
const path = require('node:path');

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });

// 1. 注册策略
const registration = String(process.env.REGISTRATION || '');
if (!['open', 'invite', 'closed'].includes(registration)) {
  add('FAIL', 'REGISTRATION', `必须显式设为 open / invite / closed 之一，当前为 ${registration || '(未设置)'}；不显式设置时服务端会取默认值，上线前必须明确`);
} else if (registration === 'open') {
  add('WARN', 'REGISTRATION=open', '任何人都能自助注册。这是你确认过的选择；若非有意，改为 invite');
} else {
  add('OK', 'REGISTRATION', registration);
}

// 2. 邀请码（invite 模式下服务端会 fail-fast，这里给出更可读的原因）
if (registration === 'invite') {
  const code = String(process.env.INVITE_CODE || '');
  if (!code || code.startsWith('REPLACE_')) add('FAIL', 'INVITE_CODE', 'invite 模式必须有真实邀请码，否则服务端会拒绝启动');
  else if (code.length < 16) add('WARN', 'INVITE_CODE', `长度仅 ${code.length}，建议至少 16 位随机值`);
  else add('OK', 'INVITE_CODE', `已设置（${code.length} 位）`);
}

// 3. 来源校验
const originUrl = String(process.env.PUBLIC_ORIGIN || '');
if (!originUrl) add('WARN', 'PUBLIC_ORIGIN', '未设置：恢复备份时少一层来源校验（仍受「敏感操作解锁」保护）。建议设为生产域名');
else if (!/^https:\/\//.test(originUrl)) add('WARN', 'PUBLIC_ORIGIN', `建议用 https:// 开头，当前为 ${originUrl}`);
else add('OK', 'PUBLIC_ORIGIN', originUrl);

// 4. 数据目录
const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
try { fs.accessSync(dir, fs.constants.W_OK); add('OK', 'DATA_DIR 可写', dir); }
catch { add('FAIL', 'DATA_DIR', `不可写或不存在：${dir}`); }

// 5. 数据库
const dbFile = process.env.DB_FILE || path.join(dir, 'ads-workbench.sqlite');
if (!fs.existsSync(dbFile)) {
  add('WARN', '数据库文件不在预期位置', `${dbFile} 不存在。若指向了错误目录，会连到一个空库，看起来像「数据丢了」；若这是首次部署可忽略`);
} else {
  add('OK', '数据库文件存在', dbFile);
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const records = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
    const docs = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
    add('OK', '数据库可读', `账号 ${users} 个、记录 ${records} 条、PDF 原文 ${docs} 份`);
    db.close();
  } catch (error) { add('WARN', '数据库读取', `无法读取（${error.message}）`); }
}

// 6. 运行时
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 16)) add('OK', 'Node 版本', process.versions.node);
else add('FAIL', 'Node 版本', `${process.versions.node} 低于要求的 22.16.0`);

// 7. 无法从进程内验证的项：不冒充结论，只交代怎么做、为什么
const manual = [
  ['端口监听地址', 'ss -lntp | grep <应用端口>', '必须是 127.0.0.1:<端口>。看到 0.0.0.0 等于绕过 Cloudflare Tunnel 直接暴露，不要上线'],
  ['备份可恢复', '在一台隔离机器上用备份恢复一次', '备份没验证过就等于没有备份'],
  ['密钥与备份分离', '确认加密密钥不在存放备份的那台机器上', '放在一起等于没加密'],
  ['日志无明文敏感值', '在日志里检索密码 / 2FA / 卡号', '后端不返回明文已有测试覆盖，但日志输出没有覆盖'],
];

const order = { FAIL: 0, WARN: 1, OK: 2 };
results.sort((a, b) => order[a.level] - order[b.level]);
for (const r of results) process.stdout.write(`[${r.level}] ${r.name} — ${r.detail}\n`);

process.stdout.write('\n以下项无法从进程内验证，必须手工确认：\n');
for (const [name, how, why] of manual) {
  process.stdout.write(`  · ${name}\n      怎么做：${how}\n      为什么：${why}\n`);
}

const failed = results.filter((r) => r.level === 'FAIL').length;
const warned = results.filter((r) => r.level === 'WARN').length;
process.stdout.write(`\n结论：${failed ? `${failed} 项必须处理` : '自动检查全部通过'}（警告 ${warned} 项、需手工确认 ${manual.length} 项）\n`);
process.exitCode = failed ? 1 : 0;
