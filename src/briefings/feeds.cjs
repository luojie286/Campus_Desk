// 仅抓取固定公开 RSS/Atom；不接收任意用户 URL，不访问聊天或个人资料。
const crypto=require('node:crypto');
const {XMLParser,XMLValidator}=require('fast-xml-parser');
const FEEDS=[
  {name:'OpenAI',category:'technology',url:'https://openai.com/news/rss.xml',hosts:['openai.com']},
  {name:'Google',category:'technology',url:'https://blog.google/rss/',hosts:['blog.google']},
  {name:'GitHub',category:'technology',url:'https://github.blog/feed/',hosts:['github.blog']},
  {name:'Microsoft Research',category:'technology',url:'https://www.microsoft.com/en-us/research/feed/',hosts:['www.microsoft.com']},
  {name:'NASA',category:'science',url:'https://www.nasa.gov/feed/',hosts:['www.nasa.gov','science.nasa.gov']},
  {name:'BBC World',category:'world',url:'https://feeds.bbci.co.uk/news/world/rss.xml',hosts:['www.bbc.com','www.bbc.co.uk']}
];
const list=value=>Array.isArray(value)?value:value?[value]:[];
function plain(value,max=300){
  return String(typeof value==='object'?value?.['#text']||'':value||'').replace(/<[^>]*>/g,' ').replace(/&(?:amp|lt|gt|quot|apos);/g,x=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[x])).replace(/\s+/g,' ').trim().slice(0,max);
}
function parseFeed(xml,feed,now){
  if(xml.length>1500000||/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw Error('feed_invalid_xml');
  const parsed=new XMLParser({ignoreAttributes:false,parseTagValue:false,processEntities:false}).parse(xml);
  const entries=list(parsed.rss?.channel?.item||parsed.feed?.entry);
  const result=[];
  for(const entry of entries){
    let link=entry.link;
    if(Array.isArray(link))link=link.find(item=>!item['@_rel']||item['@_rel']==='alternate');
    const rawUrl=typeof link==='object'?link?.['@_href']:link;
    let url;try{url=new URL(rawUrl);if(url.protocol!=='https:'||url.username||url.password||url.port||!feed.hosts.includes(url.hostname))continue;}catch{continue;}
    for(const key of [...url.searchParams.keys()])if(key.startsWith('utm_'))url.searchParams.delete(key);
    url.hash='';
    const time=Date.parse(entry.pubDate||entry.published||entry.updated||entry['dc:date']||'');
    // 没有可核对的发布时间、未来消息或超过 48 小时的条目不当作今日新闻。
    if(!Number.isFinite(time)||time>Date.parse(now)+15*60000||time<Date.parse(now)-48*3600000)continue;
    const title=plain(entry.title,220);if(!title)continue;
    const canonical=url.toString();
    result.push({ref:'news:'+crypto.createHash('sha256').update(canonical).digest('hex').slice(0,20),
      title,summary:plain(entry.description||entry.summary,320),source:feed.name,category:feed.category,
      url:canonical,published_at:new Date(time).toISOString()});
  }
  return result.sort((a,b)=>b.published_at.localeCompare(a.published_at));
}
async function readLimited(response){
  if(!response.body)throw Error('feed_empty');
  const reader=response.body.getReader();const chunks=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>1500000)throw Error('feed_too_large');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks).toString('utf8');
}
async function collectTechnologyNews({now,fetchImpl=fetch,feeds=FEEDS}){
  const results=await Promise.all(feeds.map(async feed=>{
    try{
      let target=feed.url,response;
      for(let redirect=0;redirect<=2;redirect++){
        response=await fetchImpl(target,{headers:{'User-Agent':'CampusDeskTechnologyBriefing/0.1','Accept':'application/rss+xml, application/atom+xml, application/xml, text/xml'},signal:AbortSignal.timeout(12000),redirect:'manual'});
        if(![301,302,303,307,308].includes(response.status))break;
        const next=new URL(response.headers.get('location'),target);
        await response.body?.cancel();
        if(next.origin!==new URL(feed.url).origin||redirect===2)throw Error('feed_redirect_blocked');
        target=next.toString();
      }
      if(!response.ok)throw Error('feed_http');
      const items=parseFeed(await readLimited(response),feed,now);
      return {source:feed.name,status:items.length?'ok':'no_recent_items',items};
    }catch{return {source:feed.name,status:'unavailable',items:[]};}
  }));
  const seen=new Set();const sources=[];
  for(const result of results)for(const item of result.items.slice(0,result.source==='BBC World'?5:8)){
    if(seen.has(item.url))continue;seen.add(item.url);sources.push(item);
  }
  return {sources:sources.slice(0,45),coverage:results.map(({source,status,items})=>({source,status,count:items.length}))};
}
module.exports={FEEDS,parseFeed,collectTechnologyNews};
