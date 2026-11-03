const {buildPayload,fallbackBriefing,generateBriefing,validateBriefing}=require('./core.cjs');
async function processBriefing({db,briefings,accountRef,config={},now=new Date().toISOString(),generate=generateBriefing,collect}){
  if(!accountRef)return {processed:false};
  const row=briefings.claim(accountRef,now);
  if(!row)return {processed:false};
  const settings={...briefings.settings(accountRef),time_zone:row.time_zone};
  const payload=await buildPayload(db,accountRef,now,settings,{collect});
  // 日期按本次早报固定的时区解释，生成中修改设置不能使内容跨日期。
  payload.local_date=row.local_date;
  if(!payload.sources.length){
    if(payload.coverage?.length&&payload.coverage.every(source=>source.status==='unavailable')&&row.attempts<3){
      briefings.retry(row,now,'sources_unavailable');
      return {processed:true,id:row.id,state:'queued',error:'sources_unavailable'};
    }
    briefings.complete(row,fallbackBriefing(payload),'rules',now,'no_recent_sources');
    return {processed:true,id:row.id,state:'ready',mode:'rules'};
  }
  if(row.attempts>3){
    briefings.complete(row,fallbackBriefing(payload),'rules',now,'interrupted_generation');
    return {processed:true,id:row.id,state:'ready',mode:'rules'};
  }
  try{
    const content=validateBriefing(await generate({payload,config}),payload);
    const saved=briefings.complete(row,content,'ai',now);
    return {processed:true,id:row.id,state:saved?'ready':'lease_lost',mode:'ai'};
  }catch(error){
    const raw=String(error.message||'');
    const code=/^(briefing_(key_missing|http_\d{3})|invalid_briefing_(response|reference)|empty_briefing_response)$/.test(raw)?raw:'briefing_generation_failed';
    if(row.attempts>=3||code==='briefing_key_missing'){
      briefings.complete(row,fallbackBriefing(payload),'rules',now,code);
      return {processed:true,id:row.id,state:'ready',mode:'rules'};
    }
    briefings.retry(row,now,code);
    return {processed:true,id:row.id,state:'queued',error:code};
  }
}
module.exports={processBriefing};
