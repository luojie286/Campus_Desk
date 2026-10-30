const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildConversationPayload,validateConversationResponse,suggestFromConversation}=require('../src/suggest/conversation.cjs');

const messages=[
  {id:1,content_text:'请于 202500000000 前提交材料',received_at:'2026-10-30T14:00:00.000Z',sender_id:'1278'},
  {id:2,content_text:'实验报告周五截止',received_at:'2026-10-30T14:01:00.000Z',sender_id:'1279'}
];
test('conversation LLM: payload redacts long numbers and includes existing thread keys',()=>{
  const payload=buildConversationPayload({
    conversation:{type:'group',id:'6318'},
    messages,
    existing:[{id:9,thread_key:'lab-report',title:'提交实验报告',summary:'周五截止',source_count:2}]
  });
  assert.equal(JSON.stringify(payload).includes('202500000000'),false);
  assert.equal(payload.messages.length,2);
  assert.equal(payload.existing[0].thread_key,'lab-report');
});
test('conversation LLM: validation rejects message ids outside the batch and invalid confidence',()=>{
  assert.equal(validateConversationResponse({actionable:false,reason:'闲聊'},{messageIds:[1,2]}).actionable,false);
  const ok=validateConversationResponse({
    actionable:true,thread_key:'lab-report',title:'提交实验报告',summary:'周五截止',
    category:'action',due_at:null,confidence:0.9,rationale:'通知',message_ids:[2]
  },{messageIds:[1,2]});
  assert.equal(ok.thread_key,'lab-report');
  assert.deepEqual(ok.message_ids,[2]);
  assert.throws(()=>validateConversationResponse({
    actionable:true,thread_key:'x',title:'x',summary:'',category:'action',confidence:0.9,message_ids:[999]
  },{messageIds:[1,2]}),/invalid_suggestion_message_ids/);
  assert.throws(()=>validateConversationResponse({
    actionable:true,thread_key:'x',title:'x',summary:'',category:'action',confidence:2,message_ids:[1]
  },{messageIds:[1,2]}),/invalid_conversation_suggestion/);
});
test('conversation LLM: calls DeepSeek with the redacted batch and returns one validated candidate',async()=>{
  const calls=[];
  const fakeFetch=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({
      actionable:true,thread_key:'lab-report',title:'提交实验报告',summary:'周五截止',
      category:'action',due_at:null,confidence:0.9,rationale:'通知',message_ids:[2]
    })}}]})};
  };
  const payload=buildConversationPayload({conversation:{type:'group',id:'6318'},messages,existing:[]});
  const apiKey='sk-test-conversation-123';
  const result=await suggestFromConversation({payload,config:{},apiKey,fetchImpl:fakeFetch});
  assert.equal(result.thread_key,'lab-report');
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+apiKey);
  assert.equal(calls[0].options.body.includes(apiKey),false);
  assert.equal(calls[0].options.body.includes('202500000000'),false);
  await assert.rejects(()=>suggestFromConversation({payload,config:{},apiKey:'',fetchImpl:fakeFetch}),/deepseek_api_key_missing/);
});
