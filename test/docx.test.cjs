const {test}=require('node:test');
const assert=require('node:assert/strict');
const JSZip=require('jszip');
const {extractDocxText}=require('../src/files/docx.cjs');
const {isSupportedFile,kindOf,extractFileText}=require('../src/files/extract.cjs');

async function makeDocx(text){
  const zip=new JSZip();
  zip.file('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels').file('.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word').file('document.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`);
  return zip.generateAsync({type:'nodebuffer'});
}
test('docx: extracts text from a real DOCX package and recognizes the type',async()=>{
  const buffer=await makeDocx('Word 通知正文');
  assert.equal(kindOf('通知.docx',null),'docx');
  assert.equal(isSupportedFile('通知.docx',null),true);
  const text=await extractDocxText(buffer);
  assert.equal(text.includes('Word 通知正文'),true);
  const viaDispatcher=await extractFileText(buffer,{fileName:'通知.docx',mimeType:null});
  assert.equal(viaDispatcher.includes('Word 通知正文'),true);
});
test('docx: unsupported binary Word and unknown types are explicit',async()=>{
  assert.equal(isSupportedFile('旧格式.doc',null),false);
  assert.equal(kindOf('通知.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'),'docx');
  await assert.rejects(()=>extractFileText(Buffer.from('x'),{fileName:'旧格式.doc'}),/unsupported_file_type/);
});
