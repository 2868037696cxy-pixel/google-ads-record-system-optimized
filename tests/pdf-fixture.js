'use strict';

// Real PDFs with a text layer, including repeated headers on multiple pages.
function certificate(lines = [
  'CERTIFICATE OF REGISTRATION', 'The Danish Business Authority certifies and attests that:',
  'Example ApS', 'Examplevej 1', 'DK-9310 Vodskov',
  'with CVR number: 12345678 in the municipality of Aalborg',
], pageCount = 1) {
  const escape = (value) => value.replace(/([\\()])/g, '\\$1');
  const stream = 'BT /F1 12 Tf 40 750 Td ' + lines.map((line, i) => `${i ? '0 -20 Td ' : ''}(${escape(line)}) Tj`).join('\n') + ' ET';
  const pages = Array.from({ length: pageCount }, (_, i) => 5 + i);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ...pages.map(() => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>'),
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

module.exports = { certificate };
