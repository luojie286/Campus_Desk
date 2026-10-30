const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classifyMessage,shouldSuggest}=require('../src/classify/rules.cjs');

test('rules: document links and action keywords become candidates, short chat is skipped',()=>{
  const form=classifyMessage({text:'大家填一下',links:['https://docs.qq.com/sheet/abc']});
  assert.equal(form.category,'form');
  assert.equal(shouldSuggest(form.category),true);
  const action=classifyMessage({text:'请于周五前提交报名信息',links:[]});
  assert.equal(action.category,'action');
  assert.equal(shouldSuggest(action.category),true);
  const chat=classifyMessage({text:'哈哈',links:[]});
  assert.equal(chat.category,'chat');
  assert.equal(shouldSuggest(chat.category),false);
  const unknown=classifyMessage({text:'本周实验室安排有调整，请大家查看后续详细说明并按新的时间到实验室集合',links:[]});
  assert.equal(unknown.category,'unknown');
  assert.equal(shouldSuggest(unknown.category),true);
});
