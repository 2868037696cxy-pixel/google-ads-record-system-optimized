'use strict';

const TYPE_COUNTRIES = Object.freeze({ CNPJ: 'BR', OIB: 'HR', CVR: 'DK', KRS: 'PL', NIP: 'PL', SIREN: 'FR', SIRET: 'FR', UEN: 'SG', ABN: 'AU', ACN: 'AU' });

// Extract labelled business identifiers from a PDF text layer, never from filenames.
// CNPJ supports both numeric and alphanumeric registrations (Receita Federal, 2026).
function businessIdentifier(text) {
  const source = String(text || '').normalize('NFKC');
  const matches = [];
  const add = (type, country, pattern) => {
    for (const match of source.matchAll(pattern)) {
      matches.push({ cvr: match[1].replace(/[^A-Z0-9]/gi, '').toUpperCase(), jurisdiction: country, registration_type: type });
    }
  };
  const cnpj = '([A-Z0-9]{2}\\.?[A-Z0-9]{3}\\.?[A-Z0-9]{3}\\s*\\/?\\s*[A-Z0-9]{4}\\s*-?\\s*[0-9]{2})(?![A-Z0-9])';
  add('CNPJ', 'BR', new RegExp('\\bCNPJ(?:\\s*[/·-]\\s*MF)?\\s*[:：=#-]?\\s*' + cnpj, 'gi'));
  if (/CADASTRO\s+NACIONAL\s+DA\s+PESSOA\s+JUR[IÍ]DICA/i.test(source)) {
    add('CNPJ', 'BR', new RegExp('N[UÚ]MERO\\s+DE\\s+INSCRI[ÇC][AÃ]O\\s*[:：]?\\s*' + cnpj, 'gi'));
  }
  add('OIB', 'HR', /\bOIB\s*[:：=#-]?\s*((?:[0-9][ .-]*){10}[0-9])(?![0-9])/gi);
  add('CVR', 'DK', /\bCVR(?:\s*(?:number|nr\.?|no\.?))?\s*[:：=#-]?\s*([0-9]{8})(?![0-9])/gi);
  add('KRS', 'PL', /\bKRS(?:\s*(?:number|nr\.?))?\s*[:：=#-]?\s*([0-9]{10})(?![0-9])/gi);
  add('NIP', 'PL', /\bNIP\s*[:：=#-]?\s*((?:[0-9][ -]*){9}[0-9])(?![0-9])/gi);
  add('SIREN', 'FR', /\bSIREN\s*[:：=#-]?\s*((?:[0-9][ ]*){8}[0-9])(?![0-9])/gi);
  add('SIRET', 'FR', /\bSIRET\s*[:：=#-]?\s*((?:[0-9][ ]*){13}[0-9])(?![0-9])/gi);
  add('UEN', 'SG', /\bUEN(?:\s*(?:number|no\.?))?\s*[:：=#-]?\s*([A-Z0-9]{9,10})(?![A-Z0-9])/gi);
  add('ABN', 'AU', /\bABN\s*[:：=#-]?\s*((?:[0-9][ ]*){10}[0-9])(?![0-9])/gi);
  add('ACN', 'AU', /\bACN\s*[:：=#-]?\s*((?:[0-9][ ]*){8}[0-9])(?![0-9])/gi);
  if (/COMPANIES\s+HOUSE|REGISTRAR\s+OF\s+COMPANIES\s+FOR\s+(?:ENGLAND|SCOTLAND)/i.test(source)) {
    add('CRN', 'GB', /\b(?:company\s+(?:registration\s+)?(?:number|no\.?)|registration\s+number)\s*[:：=#-]?\s*([A-Z0-9]{8})(?![A-Z0-9])/gi);
  }
  const unique = [...new Map(matches.map(item => [item.registration_type + ':' + item.cvr, item])).values()];
  // A document may also contain its representatives' OIBs. Do not guess an owner.
  const ambiguous = new Set(unique.map(item => item.jurisdiction)).size > 1 || unique.some((item, index) => unique.some((other, j) => j !== index && item.registration_type === other.registration_type));
  if (ambiguous || !unique.length) return { identity: null, identities: [], ambiguous };
  return { identity: unique[0], identities: unique, ambiguous: false };
}

function businessFields(text) {
  const lines = String(text || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const labels = {
    name: 'NOME\\s+EMPRESARIAL|RAZ[AÃ]O\\s+SOCIAL|TVRTKA|NAZIV(?:\\s+TVRTKE)?|NAZWA(?:\\s+PODMIOTU)?|DENOMINATION(?:\\s+SOCIALE)?|DÉNOMINATION(?:\\s+SOCIALE)?|COMPANY\\s+NAME|BUSINESS\\s+NAME|组织名称|公司名称|法定名称',
    address: 'LOGRADOURO|ENDERE[ÇC]O|ADRESA|STREET(?:\\s+ADDRESS)?|ADDRESS(?:\\s+LINE\\s*1)?|ADRES|ADRESSE|INDIRIZZO|DIRECCI[ÓO]N|街道地址|地址',
    apt: 'COMPLEMENTO|ADDRESS\\s+LINE\\s*2|SUITE|UNIT|门牌号|公寓或套房门牌号',
    city: 'MUNIC[IÍ]PIO|GRAD|CITY|TOWN|MIASTO|VILLE|CITT[AÀ]|CIUDAD|市(?:\\s*/\\s*区)?|城市',
    region: 'UF|ESTADO|REGION|STATE|PROVINCE|WOJEW[ÓO]DZTWO|PROVINCIA|省(?:份)?|州',
    zip: 'CEP|PO[ŠS]TANSKI\\s+BROJ|POSTAL\\s+CODE|POSTCODE|ZIP(?:\\s+CODE)?|KOD\\s+POCZTOWY|CODE\\s+POSTAL|C[ÓO]DIGO\\s+POSTAL|邮编',
    jurisdiction: 'COUNTRY(?:\\s+OF\\s+REGISTRATION)?|DR[ŽZ]AVA|PA[IÍ]S|PAYS|注册国家(?:\\s*/\\s*地区)?|注册地区',
  };
  const isLabel = new RegExp('^(?:' + Object.values(labels).join('|') + '|CNPJ|OIB|KRS|NIP|SIREN|SIRET|CVR|UEN|ABN|ACN|N[UÚ]MERO|DATA\\s+DE|SJEDI[ŠS]TE)(?:\\s*[:：]|$)', 'i');
  const fields = {};
  for (const [field, pattern] of Object.entries(labels)) {
    const label = new RegExp('^(?:' + pattern + ')(?:\\s*[:：]\\s*(.*))?$', 'i');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(label);
      if (!match) continue;
      const value = match[1] || lines[i + 1] || '';
      if (value && !isLabel.test(value)) { fields[field] = value; break; }
    }
  }
  // Brazilian certificates put the street number in its own field.
  const numberIndex = lines.findIndex(line => /^N[UÚ]MERO\s*[:：]?$/i.test(line));
  if (fields.address && numberIndex >= 0 && /^\d+[A-Z/-]*$/i.test(lines[numberIndex + 1] || '')) fields.address += ', ' + lines[numberIndex + 1];
  return fields;
}

const businessName = text => businessFields(text).name || '';
function missingFields(item) {
  return ['name', 'legal_name', 'cvr', 'jurisdiction', 'registration_type', 'address', 'city'].filter(field => !String(item[field] || '').trim());
}

function identifierError(item) {
  const type = String(item.registration_type || '').toUpperCase();
  const country = String(item.jurisdiction || '').toUpperCase();
  const expected = TYPE_COUNTRIES[type];
  if (expected && country && country !== expected) return `${type} 的注册国家应为 ${expected}，请核对编号类型与国家`;
  const number = String(item.cvr || '').normalize('NFKC').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (type === 'CNPJ' && !/^[A-Z0-9]{12}[0-9]{2}$/.test(number)) return 'CNPJ 应为 14 个字符，末两位为数字；请核对证书上的企业编号';
  if (type === 'OIB' && !/^(?:HR)?[0-9]{11}$/.test(number)) return 'OIB 应为 11 位数字；请核对企业编号，不要填写个人代表的 OIB';
  return '';
}

module.exports = { TYPE_COUNTRIES, businessIdentifier, businessName, businessFields, missingFields, identifierError };
