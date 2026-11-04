'use strict';

// 丹麦注册证书（Danish Business Authority）文本层 → 7 个固定字段。
// 与 public/license-extract.js 的浏览器规则保持一致，避免表单与提取卡片各说各话。
const LEGAL_RE = /(?:legal\s*name|legal_name|registered\s*name)\s*[:\uff1a=]\s*(.+)/i;
const UNIT_PREFIX = /^(?:c\/o|C\/O|att\.|Att\.)\b/;
const UNIT_WORD = /^(?:sal|sal\.|st\.|suite|lejl|lejlighed|floor|etage|tv|th|mf)\b/i;
const UNIT_SPLIT_1 = /^(.*?)(\s*(?:c\/o|C\/O|att\.|Att\.)\s+.*)$/;
const UNIT_SPLIT_2 = /^(.*?),\s*(.*(?:sal|sal\.|st\.|st\b|suite|lejl|lejlighed|floor|etage|tv\b|th\b|mf\b).*)$/i;
// “Trindholmsgade 4, 4.” 这类楼层/房号写在街道同一行的情况。
const UNIT_SPLIT_3 = /^(.*?),\s*((?:\d+\.\s*\w{0,3}|\w{1,3}\.\s*\w{1,3}))$/i;
const POSTAL_RE = /^(?:DK-)?(\d{4})\s+(.+)$/;

function splitUnit(street) {
  for (const pattern of [UNIT_SPLIT_1, UNIT_SPLIT_2, UNIT_SPLIT_3]) {
    const match = pattern.exec(street);
    if (match) return [match[1].trim(), match[2].trim()];
  }
  return [street, ''];
}

function parse(text) {
  const lines = String(text || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const at = lines.findIndex((line) => /certifies and attests/i.test(line));
  if (at < 0) return null;
  let name = '', street = '', unit = '', postal = '', city = '', legal = '';
  let block = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    const match = POSTAL_RE.exec(line);
    if (match) { postal = match[1]; city = match[2].trim(); break; }
    if (/^with cvr/i.test(line) || /CVR number/i.test(line)) break;
    block.push(line);
  }
  // 部分证书的城市行和地址行距较远，退回到“邮编行前三行”。
  if (!postal) {
    for (let i = at + 1; i < lines.length; i++) {
      const match = POSTAL_RE.exec(lines[i]);
      if (match) { postal = match[1]; city = match[2].trim(); block = lines.slice(Math.max(at + 1, i - 3), i); break; }
    }
  }
  if (block.length >= 2) {
    name = block[0];
    street = block[1];
    let rest = block.slice(2);
    if (!/\d/.test(street)) {
      const candidate = block.slice(1).find((line) => /\d/.test(line));
      if (candidate) { street = candidate; rest = block.slice(1).filter((line) => line !== candidate); }
    }
    for (const line of rest) {
      if (UNIT_PREFIX.test(line) || UNIT_WORD.test(line)) unit = line;
    }
  } else if (block.length === 1) {
    name = block[0];
  }
  for (const line of lines) { const match = LEGAL_RE.exec(line); if (match) { legal = match[1].trim(); break; } }
  if (street) [street, unit] = splitUnit(street);
  if (!name || !postal) return null;
  return { name, legal_name: legal || name, address: street, apt: unit, zip: postal, city };
}

module.exports = { parse, splitUnit };
