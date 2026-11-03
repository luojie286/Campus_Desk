// Android 合约测试专用：全部资料是合成数据，数据库只在内存；不加载私有配置或执行 worker。
const http=require('node:http');
const {openStore,digest}=require('../src/core.cjs');
const {applyMigrations}=require('../src/db/migrate.cjs');
const {createMessageRepository}=require('../src/db/repositories/messages.cjs');
const {createSuggestionRepository}=require('../src/db/repositories/suggestions.cjs');
const {createTaskRepository}=require('../src/db/repositories/tasks.cjs');
const {createJobRepository}=require('../src/db/repositories/jobs.cjs');
const {createV2Handler}=require('../src/api/v2.cjs');
const {createBriefingRepository}=require('../src/briefings/repository.cjs');
const store=openStore(':memory:');applyMigrations(store.db);
const messages=createMessageRepository(store.db),suggestions=createSuggestionRepository(store.db);
const tasks=createTaskRepository(store.db),jobs=createJobRepository(store.db);
const accountRef='9999';
const config={account_id:accountRef,token:'synthetic-mobile-contract-token-00000000',execute:true};
const briefings=createBriefingRepository(store.db);
for(let i=1;i<=2;i++){
  const message=messages.insert({platform:'qq',adapterInstance:'fixture',accountRef,conversationType:'group',conversationId:'1111',
    senderId:'2222',sourceMessageId:'fixture-'+i,kind:'text',contentText:'合成通知 '+i,linkJson:[],contentJson:null,
    sourceTime:new Date().toISOString(),receivedAt:new Date().toISOString(),completeness:'full',identityQuality:'stable_id',rawJson:'{}'});
  suggestions.insert({messageId:message.id,title:'合成候选 '+i,summary:'仅用于本机自动测试',category:'action',accountRef,
    conversationType:'group',conversationId:'1111',threadKey:'fixture-'+i});
}
for(let i=1;i<=2;i++){
  const task=tasks.create({requestKey:'fixture-'+i,accountRef,targetRef:'https://docs.qq.com/sheet/SYNTHETIC'});
  tasks.transition({id:task.id,accountRef,event:'start'});
  if(i===1){
    const plan={identityMode:'full',identityRow:2,changes:[{row:2,col:3,field:'age',before:'',value:'19'}],warnings:[],missing:[]};
    tasks.savePlan({taskId:task.id,plan,digest:digest(plan)});
    tasks.transition({id:task.id,accountRef,event:'ready_for_approval'});
  }else{
    const waiting=tasks.transition({id:task.id,accountRef,event:'need_input'});
    tasks.setQuestions({taskId:task.id,taskVersion:waiting.state_version,questions:[{key:'phone',label:'示例联系电话'}]});
  }
}
const handler=createV2Handler({config,messages,suggestions,tasks,jobs,briefings});
const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({running:true}));return;}
  const url=new URL(req.url,'http://127.0.0.1');
  if(!await handler(req,res,url.pathname,url.searchParams)){res.statusCode=404;res.end('{}');}
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({base:'http://127.0.0.1:'+server.address().port})+'\n'));
