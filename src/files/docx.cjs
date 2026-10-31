// DOCX 文本提取：mammoth 只读解析 Word 的 document.xml，不执行宏或嵌入脚本。
const mammoth=require('mammoth');

async function extractDocxText(buffer){
  const result=await mammoth.extractRawText({buffer});
  return result&&typeof result.value==='string'?result.value:'';
}

module.exports={extractDocxText};
