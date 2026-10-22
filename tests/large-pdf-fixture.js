'use strict';
// Valid one-page PDF with an unused large stream; no rendering or real data.
module.exports=function largePdf(index){
  const stream=Buffer.alloc(8*1024*1024,65+index),pieces=[Buffer.from('%PDF-1.7\n')],offsets=[0];let length=pieces[0].length;
  const object=(id,body)=>{offsets[id]=length;const bytes=Buffer.concat([Buffer.from(`${id} 0 obj\n`),Buffer.isBuffer(body)?body:Buffer.from(body),Buffer.from('\nendobj\n')]);pieces.push(bytes);length+=bytes.length;};
  object(1,'<< /Type /Catalog /Pages 2 0 R >>');object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>');object(4,'<< /Length 4 >>\nstream\nq Q\nendstream');
  object(5,Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),stream,Buffer.from('\nendstream')]));
  const xref=length;pieces.push(Buffer.from('xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));return Buffer.concat(pieces);
};
