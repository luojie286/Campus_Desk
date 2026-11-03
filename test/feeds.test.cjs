const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseFeed,collectTechnologyNews}=require('../src/briefings/feeds.cjs');
const now='2026-11-03T23:00:00.000Z';
const feed={name:'Example',category:'technology',url:'https://example.com/feed',hosts:['example.com']};
const xml=`<rss><channel><item><title>New &amp; useful tool</title><link>https://example.com/new?utm_source=rss</link><pubDate>Tue, 03 Nov 2026 20:00:00 GMT</pubDate><description><![CDATA[<b>Short</b> summary]]></description></item>
<item><title>old</title><link>https://example.com/old</link><pubDate>2020-01-01</pubDate></item>
<item><title>undated</title><link>https://example.com/undated</link></item>
<item><title>future</title><link>https://example.com/future</link><pubDate>2030-01-01</pubDate></item>
<item><title>bad host</title><link>https://evil.example/new</link><pubDate>2026-11-03T20:00:00Z</pubDate></item></channel></rss>`;
test('feeds: parse RSS preserve sources and dates reject stale undated future and foreign URLs',()=>{
  const items=parseFeed(xml,feed,now);assert.equal(items.length,1);assert.equal(items[0].title,'New & useful tool');assert.equal(items[0].url,'https://example.com/new');assert.equal(items[0].summary,'Short summary');assert.equal(items[0].source,'Example');
});
test('feeds: Atom links and publication dates are supported',()=>{
  const items=parseFeed('<feed><entry><title>Atom</title><link rel="alternate" href="https://example.com/atom"/><published>2026-11-03T20:00:00Z</published></entry></feed>',feed,now);
  assert.equal(items.length,1);assert.equal(items[0].url,'https://example.com/atom');
});
test('feeds: reject doctypes entities malformed and oversized XML',()=>{
  for(const xml of ['<!DOCTYPE rss [<!ENTITY x "example">]><rss/>','not xml','x'.repeat(1500001)])assert.throws(()=>parseFeed(xml,feed,now),/feed_invalid_xml/);
});
test('feeds: failed source is isolated and duplicate article URLs are deduped',async()=>{
  const value=await collectTechnologyNews({now,feeds:[feed,{...feed,name:'Duplicate'},{...feed,name:'Failed',url:'https://example.com/fail'}],fetchImpl:async url=>{
    if(url.endsWith('fail'))throw Error('network down');return new Response(xml);
  }});
  assert.equal(value.sources.length,1);assert.equal(value.coverage.length,3);assert.equal(value.coverage[2].status,'unavailable');
});
test('feeds: failed HTTP and excessive payloads do not become news',async()=>{
  const value=await collectTechnologyNews({now,feeds:[feed],fetchImpl:async()=>new Response('x'.repeat(1500001))});
  assert.equal(value.sources.length,0);assert.equal(value.coverage[0].status,'unavailable');
});
test('feeds: follow bounded same-origin redirects but never redirect to a foreign host',async()=>{
  let calls=0;
  const ok=await collectTechnologyNews({now,feeds:[feed],fetchImpl:async()=>++calls===1?new Response(null,{status:301,headers:{location:'https://example.com/new-feed'}}):new Response(xml)});
  assert.equal(calls,2);assert.equal(ok.sources.length,1);
  calls=0;const bad=await collectTechnologyNews({now,feeds:[feed],fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://other.example/feed'}});}});
  assert.equal(calls,1);assert.equal(bad.sources.length,0);
});
