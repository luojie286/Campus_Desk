const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSuggestionPayload,validateSuggestionResponse,suggestFromMessage}=require('../src/suggest/llm.cjs');

const message={contentText:'学号 202500000000 的同学请填写，电话 13800000000',links:['https://docs.qq.com/sheet/abc']};
const classification={category:'form',confidence:0.95,rule:'has_document_link'};

test('suggestion: payload redacts long numbers and keeps document links, without profile values',()=>{
  const text=JSON.stringify(buildSuggestionPayload({message,classification}));
  assert.equal(text.includes('202500000000'),false);
  assert.equal(text.includes('13800000000'),false);
  assert.equal(text.includes('docs.qq.com/sheet/abc'),true);
  assert.equal(text.includes('has_document_link'),true);
  assert.equal(text.includes('student_id'),false);
});
test('suggestion: validation rejects invalid actionable responses and accepts a negative decision',()=>{
  assert.equal(validateSuggestionResponse({actionable:false}).actionable,false);
  const ok=validateSuggestionResponse({actionable:true,title:'填写报名表',summary:'群内发布了报名表',category:'form',due_at:null,confidence:0.9,rationale:'含文档链接'});
  assert.equal(ok.title,'填写报名表');
  assert.throws(()=>validateSuggestionResponse({actionable:true,title:'',confidence:0.9}),/invalid_suggestion/);
  assert.throws(()=>validateSuggestionResponse({actionable:true,title:'x',confidence:2}),/invalid_suggestion/);
  assert.throws(()=>validateSuggestionResponse({actionable:'yes',title:'x'}),/invalid_suggestion/);
});
test('suggestion: calls DeepSeek with redacted payload and returns a validated decision',async()=>{
  const calls=[];
  const fakeFetch=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({
      actionable:true,title:'填写报名表',summary:'群内发布了报名表',category:'form',due_at:null,confidence:0.9,rationale:'含文档链接'
    })}}]})};
  };
  const payload=buildSuggestionPayload({message,classification});
  const apiKey='sk-test-UNIQUE-123';
  const result=await suggestFromMessage({payload,config:{},apiKey,fetchImpl:fakeFetch});
  assert.equal(result.actionable,true);
  assert.equal(result.title,'填写报名表');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+apiKey);
  assert.equal(calls[0].options.body.includes(apiKey),false);
  assert.equal(calls[0].options.body.includes('202500000000'),false);
  await assert.rejects(()=>suggestFromMessage({payload,config:{},apiKey:'',fetchImpl:fakeFetch}),/deepseek_api_key_missing/);
});
