const {test}=require('node:test');
const assert=require('node:assert/strict');
const {detectDocumentAdapter,findDocumentAdapter,assertAdapterImplemented}=require('../src/documents/registry.cjs');

test('documents: recognize Tencent and reserve WPS/Feishu adapters without implementing them',()=>{
  const tencent=detectDocumentAdapter('https://docs.qq.com/sheet/abc?tab=BB08J2');
  assert.equal(tencent.id,'tencent_sheet');
  assert.equal(tencent.implemented,true);
  assert.equal(tencent.normalize('https://docs.qq.com/sheet/abc?tab=BB08J2'),'https://docs.qq.com/sheet/abc?tab=BB08J2');
  assert.equal(detectDocumentAdapter('https://www.kdocs.cn/l/abc').id,'wps_sheet');
  assert.equal(detectDocumentAdapter('https://example.feishu.cn/sheets/abc').id,'feishu_sheet');
  assert.equal(findDocumentAdapter('wps_sheet').implemented,false);
  assert.throws(()=>assertAdapterImplemented('wps_sheet'),/document_adapter_not_implemented/);
  assert.equal(assertAdapterImplemented('tencent_sheet').id,'tencent_sheet');
});
