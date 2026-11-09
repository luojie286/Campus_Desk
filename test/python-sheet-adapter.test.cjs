const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {run}=require('../tools/python-sheet-adapter.cjs');

test('Python sheet bridge: known headers can prepare an empty row locally',async()=>{
  const input={action:'prepare',target:'https://docs.qq.com/sheet/synthetic',
    profile:{name:'合成姓名',student_id:'001',major:'合成专业'}};
  const createSheet=()=>({
    async open(){},
    async readUsedRange(){return [['姓名','学号','专业']];},
    async close(){}
  });
  const prepared=await run(input,{llm:{base_url:'http://127.0.0.1:1'}},createSheet);
  assert.equal(prepared.ok,true);
  assert.equal(prepared.plan.notes,'known_headers');
  assert.deepEqual(prepared.plan.changes.map(item=>[item.row,item.col,item.field]),
    [[2,1,'name'],[2,2,'student_id'],[2,3,'major']]);
});

test('Python sheet bridge: preserves safe read errors and suppresses unknown details',async()=>{
  const input={action:'probe',target:'https://docs.qq.com/sheet/synthetic'};
  const createSheet=message=>()=>({
    async open(){},
    async readUsedRange(){throw Error(message);},
    async close(){}
  });
  for(const [message,code] of [
    ['sheet_grid_focus_failed','sheet_grid_focus_failed'],
    ['unexpected detail','sheet_adapter_failed']
  ]){
    assert.deepEqual(await run(input,{},createSheet(message)),{ok:false,attempted:false,code});
  }
});

test('Python sheet bridge: synthetic page preparation, final authorization, independent readback',
  {skip:process.env.LAB1_ASSISTANT_BROWSER_FIXTURE!=='1'},async()=>{
    const browser=await chromium.launch({channel:'msedge',headless:true});
    const cells=[['姓名','学号','年级'],['合成甲','001','']];
    const target='https://docs.qq.com/sheet/synthetic';
    const profile={name:'合成甲',student_id:'001',grade:'二年级'};
    let opens=0,writes=0,checks=0;
    function factory(){
      let context,page;
      return {
        get page(){return page;},
        async open(){
          opens++;
          context=await browser.newContext();
          await context.route(target,route=>route.fulfill({contentType:'text/html',body:'<table></table>'}));
          page=await context.newPage();
          await page.goto(target);
          await page.locator('table').evaluate((table,rows)=>{
            for(const row of rows)for(const text of row){
              if(table.rows.length===0||table.rows[table.rows.length-1].cells.length===row.length)table.insertRow();
              table.rows[table.rows.length-1].insertCell().textContent=text;
            }
          },cells);
        },
        async isEditable(){return true;},
        async readUsedRange(){
          return page.locator('tr').evaluateAll(rows=>rows.map(row=>Array.from(row.cells,cell=>cell.textContent)));
        },
        async applyGeneral(plan){
          writes++;
          for(const item of plan.changes){
            await page.locator('tr').nth(item.row-1).locator('td').nth(item.col-1)
              .evaluate((cell,value)=>{cell.textContent=value;},item.value);
          }
          cells.splice(0,cells.length,...await this.readUsedRange());
        },
        async verifyGeneral(plan){
          const rows=await this.readUsedRange();
          return plan.changes.every(item=>rows[item.row-1][item.col-1]===item.value);
        },
        async close(){await context?.close();}
      };
    }
    const analyze=async()=>({mappings:[{column:3,field:'grade'}],confidence:1,notes:''});
    try{
      const prepared=await run({action:'prepare',target,profile},{execute:false},factory,analyze);
      assert.equal(prepared.ok,true);
      assert.equal(writes,0);
      assert.equal(prepared.plan.changes[0].before,'');
      const input={action:'execute',target,profile,plan:prepared.plan};
      const stale=await run(input,{execute:true},factory,analyze,()=>{throw Error('plan_not_current');});
      assert.deepEqual(stale,{ok:false,attempted:false,code:'plan_not_current'});
      const finished=await run(input,{execute:true},factory,analyze,()=>checks++);
      assert.deepEqual(finished,{ok:true,matched:true});
      const verified=await run({...input,action:'reconcile'},{execute:false},factory);
      assert.deepEqual(verified,{ok:true,matched:true});
      assert.equal(opens,5);
      assert.equal(writes,1);
      assert.equal(checks,1);
      cells[1][1]='different identity';
      assert.deepEqual(await run({...input,action:'reconcile'},{execute:false},factory),{ok:true,matched:false});
      assert.equal(writes,1);
    }finally{await browser.close();}
  });
