const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {extractPdfText}=require('../src/files/pdf.cjs');
const {downloadOneBotFile}=require('../src/files/onebot.cjs');

const localDir=fs.mkdtempSync(path.join(os.tmpdir(),'campus-desk-onebot-'));
after(()=>fs.rmSync(localDir,{recursive:true,force:true}));

function makePdf(text){
  const stream=`BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects={
    1:'<< /Type /Catalog /Pages 2 0 R >>',
    2:'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3:'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    4:`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    5:'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  };
  let body='%PDF-1.4\n';
  const offsets=[0];
  for(let i=1;i<=5;i++){
    offsets[i]=Buffer.byteLength(body,'latin1');
    body+=`${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref=Buffer.byteLength(body,'latin1');
  body+='xref\n0 6\n0000000000 65535 f \n';
  for(let i=1;i<=5;i++)body+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  body+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body,'latin1');
}
test('pdf: extracts text from a real minimal PDF',async()=>{
  const text=await extractPdfText(makePdf('Hello PDF notice'));
  assert.equal(text.includes('Hello PDF notice'),true);
});
test('onebot file: prefers base64 and sends the adapter token',async()=>{
  const calls=[];
  const buffer=await downloadOneBotFile({
    fileId:'f1',fileName:'notice.pdf',config:{token:'test-token'},
    fetchImpl:async(url,options)=>{
      calls.push({url,options});
      return {ok:true,status:200,json:async()=>({status:'ok',data:{base64:Buffer.from('pdf-bytes').toString('base64')}})};
    }
  });
  assert.equal(buffer.toString(),'pdf-bytes');
  assert.equal(calls[0].url,'http://127.0.0.1:9088/get_file');
  assert.equal(calls[0].options.headers.Authorization,'Bearer test-token');
  assert.equal(JSON.parse(calls[0].options.body).file_id,'f1');
});
test('onebot file: falls back to the temporary URL returned by get_file',async()=>{
  let call=0;
  const buffer=await downloadOneBotFile({
    fileId:'f2',fileName:'notice.pdf',config:{onebot:{token:'adapter-token'}},
    fetchImpl:async(url)=>{
      call++;
      if(call===1)return {ok:true,status:200,json:async()=>({status:'ok',data:{url:'http://127.0.0.1/tmp/f2'}})};
      return {ok:true,status:200,arrayBuffer:async()=>Uint8Array.from(Buffer.from('url-bytes')).buffer};
    }
  });
  assert.equal(buffer.toString(),'url-bytes');
});
test('onebot file: reads a local path only when it is under an allowed root',async()=>{
  const local=path.join(localDir,'notice.pdf');
  fs.writeFileSync(local,'local-bytes');
  const buffer=await downloadOneBotFile({
    fileId:'f3',fileName:'notice.pdf',
    config:{token:'adapter-token',files:{allowed_roots:[localDir]}},
    fetchImpl:async()=>({ok:true,status:200,json:async()=>({status:'ok',data:{url:local}})})
  });
  assert.equal(buffer.toString(),'local-bytes');
  await assert.rejects(
    () => downloadOneBotFile({
      fileId:'f4',fileName:'outside.pdf',
      config:{token:'adapter-token',files:{allowed_roots:[path.join(localDir,'missing')]}},
      fetchImpl:async()=>({ok:true,status:200,json:async()=>({status:'ok',data:{url:local}})})
    }),
    /file_path_not_allowed/
  );
});
