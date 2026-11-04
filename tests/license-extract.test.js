'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const extract = require('../public/license-extract');

test('固定字段按表单顺序输出，证书值保留原文', () => {
  const rows = extract.fields({ name: 'MJ TECH ApS', address: 'Sandhøjen 9', apt: 'c/o Michael Jacobsen', zip: 'DK-2720', city: 'Vanløse' });
  assert.deepEqual(rows.map(([label]) => label), ['资料类型', '组织名称', '法定名称', '街道地址', '公寓或套房等的门牌号', '邮编', '市/区']);
  assert.equal(rows[0][1], '组织');
  assert.equal(rows[1][1], 'MJ TECH ApS');
  assert.equal(rows[2][1], 'MJ TECH ApS');
  assert.equal(rows[3][1], 'Sandhøjen 9');
  assert.equal(rows[4][1], 'c/o Michael Jacobsen');
  assert.equal(rows[5][1], '2720');
  assert.equal(rows[6][1], 'Vanløse');
});

test('缺字段写“未提供”，虚假字段不显示', () => {
  const rows = extract.fields({ cvr: '12345678', city: 'Herning' });
  assert.equal(rows.length, 7);
  assert.equal(rows.find(([label]) => label === '组织名称')[1], '未提供');
  assert.equal(rows.find(([label]) => label === '邮编')[1], '未提供');
  assert.equal(rows.some(([label]) => /CVR|注册/.test(label)), false);
});

test('法定名称为空时沿用组织名称', () => {
  const rows = extract.fields({ name: 'Aarvig E-handel', legal_name: '   ' });
  assert.equal(rows.find(([label]) => label === '法定名称')[1], 'Aarvig E-handel');
});

test('邮编去掉国家前缀，保留非数字邮编', () => {
  assert.equal(extract.fields({ zip: 'DK-2720' })[5][1], '2720');
  assert.equal(extract.fields({ zip: 'EC1A 1BB' })[5][1], 'EC1A 1BB');
});

test('丹麦证书按原文拆出街道与楼层，邮编去掉 DK-', () => {
  const text = [
    'CERTIFICATE OF REGISTRATION',
    'The Danish Business Authority certifies and attests that:',
    "Men's Collection ApS",
    'Trindholmsgade 4, 4.',
    'DK-6000 Kolding',
    'with CVR number: 42160318 in the municipality of Kolding is registered as Private limited company in',
  ].join('\n');
  assert.deepEqual(extract.parseText(text), {
    name: "Men's Collection ApS", legal_name: "Men's Collection ApS", address: 'Trindholmsgade 4', apt: '4.', zip: '6000', city: 'Kolding', type: '组织',
  });
  assert.equal(extract.fields(extract.parseText(text))[3][1], 'Trindholmsgade 4');
  assert.equal(extract.fields(extract.parseText(text))[4][1], '4.');
});

test('非丹麦证书不套用丹麦拆分规则，沿用已识别字段', () => {
  assert.equal(extract.parseText('ACME LLC\n1 Main Street\nSpringfield'), null);
  assert.equal(extract.fields({ name: 'ACME LLC', address: '1 Main Street', city: 'Springfield' })[3][1], '1 Main Street');
});

test('复制全部文本一行一个字段，txt 文件名沿用原文件名', () => {
  assert.equal(extract.text({ name: 'PBF Auto ApS', address: 'Følfodvej 1', zip: '9310', city: 'Vodskov' }).split('\n').length, 7);
  assert.equal(extract.filename('registreringscertifikat_digitaltsigneret_26733995.pdf'), 'registreringscertifikat_digitaltsigneret_26733995_extracted.txt');
});
