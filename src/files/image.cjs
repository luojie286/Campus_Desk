// 本地 OCR：使用 tesseract.js 和中英文模型，不把图片发送到第三方视觉模型。
const path=require('node:path');
const {createWorker}=require('tesseract.js');

let workerPromise=null;

async function worker(){
  if(!workerPromise){
    workerPromise=createWorker('chi_sim+eng',1,{
      langPath:path.resolve('.private/ocr'),
      cachePath:path.resolve('.private/ocr'),
      gzip:true,
      logger:()=>{}
    });
  }
  return workerPromise;
}

async function extractImageText(buffer){
  const instance=await worker();
  const result=await instance.recognize(buffer);
  return result?.data?.text||'';
}

async function closeImageWorker(){
  if(!workerPromise)return;
  const instance=await workerPromise.catch(()=>null);
  if(instance)await instance.terminate().catch(()=>{});
  workerPromise=null;
}

module.exports={extractImageText,closeImageWorker};
