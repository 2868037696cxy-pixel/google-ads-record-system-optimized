'use strict';

// The same mapping drives normal edits, resource synchronization and diagnostics.
const LINKS = Object.freeze({
  email: Object.freeze({ kind: 'emails', label: '邮箱', exclusive: true, fields: { email_user: ['user', '邮箱账号'], email_pass: ['pass', '邮箱密码'], email_fakey: ['fakey', '邮箱 2FA'] } }),
  proxy: Object.freeze({ kind: 'proxies', label: '代理', exclusive: false, fields: { proxy_sn: ['sn', '代理编号'], proxy_type: ['type', '代理类型'], proxy_host: ['host', '代理主机'], proxy_port: ['port', '代理端口'], proxy_user: ['user', '代理账号'], proxy_pass: ['pass', '代理密码'], proxy_country: ['country', '代理国家'], proxy_ip: ['ip', '出口 IP'] } }),
  card: Object.freeze({ kind: 'cards', label: '付款工具', exclusive: true, fields: { card_number: ['number', '工具别名'], card_expiry: ['expiry', '有效期'], card_last4: ['last4', '末四位'] } }),
  license: Object.freeze({ kind: 'licenses', label: '营业执照', exclusive: true, fields: { license_name: ['name', '组织名称'] } }),
});
const SNAP = Object.freeze(Object.fromEntries(Object.entries(LINKS).map(([prefix, link]) => [prefix, resource => Object.fromEntries(Object.entries(link.fields).map(([field, [source]]) => [field, resource[source]]))])));
module.exports = { LINKS, SNAP };
