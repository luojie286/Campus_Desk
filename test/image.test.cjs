const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const {kindOf,isSupportedFile}=require('../src/files/extract.cjs');
const {extractImageText,closeImageWorker}=require('../src/files/image.cjs');

after(()=>closeImageWorker());
test('image: recognizes supported image types and runs local OCR',async()=>{
  assert.equal(kindOf('截图.png',null),'image');
  assert.equal(kindOf('photo.webp','image/*'),'image');
  assert.equal(isSupportedFile('截图.png',null),true);
  const canvas=createCanvas(640,220);
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,640,220);
  ctx.fillStyle='#111';ctx.font='64px Arial';ctx.fillText('Hello 123',30,120);
  const buffer=canvas.toBuffer('image/png');
  const text=await extractImageText(buffer);
  assert.equal(text.includes('Hello'),true);
});
