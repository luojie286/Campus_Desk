// 按扩展名/MIME 选择纯文本提取器；旧式 .doc 二进制格式不在当前范围。
const path=require('node:path');
const {extractPdfText}=require('./pdf.cjs');
const {extractDocxText}=require('./docx.cjs');
const {extractImageText}=require('./image.cjs');

const PDF_MIME='application/pdf';
const DOCX_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGE_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.webp','.bmp']);

function kindOf(fileName,mimeType){
  const extension=path.extname(String(fileName||'')).toLowerCase();
  const mime=String(mimeType||'').toLowerCase();
  if(extension==='.pdf'||mime===PDF_MIME)return 'pdf';
  if(extension==='.docx'||mime===DOCX_MIME)return 'docx';
  if(IMAGE_EXTENSIONS.has(extension)||mime.startsWith('image/'))return 'image';
  return null;
}

function isSupportedFile(fileName,mimeType){
  return kindOf(fileName,mimeType)!==null;
}

async function extractFileText(buffer,{fileName,mimeType}={}){
  const kind=kindOf(fileName,mimeType);
  if(kind==='pdf')return extractPdfText(buffer);
  if(kind==='docx')return extractDocxText(buffer);
  if(kind==='image')return extractImageText(buffer);
  throw Error('unsupported_file_type');
}

module.exports={isSupportedFile,extractFileText,kindOf};
