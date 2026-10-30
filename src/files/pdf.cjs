// PDF 解析适配层：把 pdf-parse 的 API 隔离在这里，便于以后替换实现。
const {PDFParse}=require('pdf-parse');

async function extractPdfText(buffer){
  const parser=new PDFParse({data:buffer});
  try{
    const result=await parser.getText();
    return result&&typeof result.text==='string'?result.text:'';
  }finally{
    if(typeof parser.destroy==='function')await parser.destroy().catch(()=>{});
  }
}

module.exports={extractPdfText};
