const path=require('node:path');
const {buildPlan,canonicalUrl,parseTsv,findIdentityRow,assertWritePreconditions,changesMatch}=require('./core.cjs');
function column(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}

class TencentSheet {
  constructor(config){this.config=config;}
  async open(url,login=false){
    // 可见登录辅助器占用同一专用配置目录时，不启动第二个浏览器。
    if(!login && require('node:fs').existsSync('.private/login.pid')){
      const pid=Number(require('node:fs').readFileSync('.private/login.pid','utf8').trim());
      let alive=false;try{process.kill(pid,0);alive=true;}catch{}
      if(alive)throw Error('document_login_window_open_close_it_first');
    }
    const {chromium}=require(process.env.LAB_PLAYWRIGHT_PATH||'playwright');
    const profile=path.resolve(this.config.browser_profile||'.private/browser');
    if(!profile.startsWith(path.resolve('.private')+path.sep))throw Error('browser_profile_outside_private_directory');
    this.context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:!login,viewport:{width:1280,height:800}});
    // 区域读取依赖页面复制到剪贴板；只在腾讯文档来源授予读写权限。
    await this.context.grantPermissions(['clipboard-read','clipboard-write'],{origin:'https://docs.qq.com'});
    this.page=await this.context.newPage();
    await this.page.goto(canonicalUrl(url),{waitUntil:'domcontentloaded',timeout:30000});
    await this.page.locator('#alloy-simple-text-editor').waitFor({timeout:30000});
    // 此原型只允许本站。导航或授权超时明确报错，不绕过验证。
    if(new URL(this.page.url()).hostname!=='docs.qq.com')throw Error('login_required');
    await this.select('A1');
    // 框架节点出现时，远端单元格数据仍可能在加载；须等真实表头到达。
    await this.page.waitForFunction(()=>document.querySelector('#alloy-simple-text-editor')?.textContent.trim().length>0,null,{timeout:15000});
  }
  // 名称框存在时序问题：输入后立刻回车会提交上一个地址。
  // 每次选择最多尝试两次，失败后重新点击并输入。
  async select(address){
    let lastError=null;
    for(let attempt=1;attempt<=2;attempt++){
      try{await this.selectOnce(address);return;}catch(error){lastError=error;}
    }
    throw lastError;
  }
  async selectOnce(address){
    const box=this.page.locator('input.bar-label');
    await box.click();
    await box.press('Control+A');
    await box.pressSequentially(address);
    // 先确认输入框真的显示目标地址，再回车；这是之前选错单元格的根因。
    await this.page.waitForFunction(target=>document.querySelector('input.bar-label')?.value===target,address,{timeout:3000});
    await this.page.waitForTimeout(100);
    await box.press('Enter');
    try{await this.page.waitForFunction(target=>document.querySelector('input.bar-label')?.value===target,address,{timeout:5000});}
    catch{await this.page.screenshot({path:'.private/selection-error.png'});throw Error('selection_not_applied_'+address+'_actual_'+await this.page.locator('input.bar-label').inputValue());}
    // 等待页面自身的两次渲染，不使用固定屏幕坐标或 OCR。
    await this.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  // 点击网格内部取得键盘焦点；点击只改变选中单元格，不修改内容。
  async focusGrid(){
    const board=this.page.locator('.operate-board').first();
    await board.waitFor({timeout:10000});
    const box=await board.boundingBox();
    if(!box)throw Error('sheet_grid_not_found');
    for(let attempt=1;attempt<=3;attempt++){
      await this.page.mouse.click(box.x+40,box.y+35);
      await this.page.waitForTimeout(200);
      // 不能只看名称框：open() 已把名称框设为 A1，点击没生效时它仍是非空。
      // 表格的键盘焦点落在隐藏输入层（.table-input），不在 .operate-board 内；
      // 因此只要求焦点已离开页面 body、且不在名称框输入框上。
      const focused=await this.page.evaluate(()=>{
        const active=document.activeElement;
        if(!active||active===document.body)return false;
        return !(active.tagName==='INPUT'&&active.classList.contains('bar-label'));
      });
      if(focused)return;
      await this.page.waitForTimeout(300);
    }
    throw Error('sheet_grid_focus_failed');
  }
  // 读取当前工作表已用区域：先点网格取得键盘焦点，Ctrl+A 选中，Ctrl+C 后从页面剪贴板取 TSV。
  // 剪贴板只在内存中解析，不写日志；调用方负责在发送模型前裁剪为表头和本人行。
  async readUsedRange(){
    for(let attempt=1;attempt<=3;attempt++){
      await this.focusGrid();
      await this.page.keyboard.press('Control+A');
      await this.page.waitForTimeout(300);
      await this.page.keyboard.press('Control+C');
      await this.page.waitForTimeout(600);
      let copied='';
      try{copied=await this.page.evaluate(()=>navigator.clipboard.readText());}
      catch{throw Error('clipboard_read_failed');}
      if(!copied.trim())continue; // 焦点或渲染未就绪时重新点击再试。
      if(copied.length>(this.config.max_clipboard_chars||2000000))throw Error('clipboard_too_large');
      const rows=parseTsv(copied);
      if(!rows.length)throw Error('sheet_empty');
      if(rows.length>(this.config.max_read_rows||500))throw Error('sheet_too_many_rows');
      if(rows.some(row=>row.length>(this.config.max_read_cols||100)))throw Error('sheet_too_many_columns');
      return rows;
    }
    throw Error('clipboard_empty');
  }
  async readCell(address){await this.select(address);return (await this.page.locator('#alloy-simple-text-editor').innerText()).trim();}
  async readTable(){
    const rows=[];
    // 限制为当前四列测试表，最多读取配置行数，不把任意复杂表当作已支持。
    for(let r=1;r<=this.config.max_rows;r++){
      const row=[];for(let c=1;c<=4;c++)row.push(await this.readCell(column(c)+r));rows.push(row);
    }
    return rows;
  }
  async isEditable(){return await this.page.locator('#alloy-simple-text-editor').getAttribute('contenteditable')==='true';}
  async prepare(profile){const rows=await this.readTable();try{return buildPlan(rows,profile);}catch(error){require('node:fs').writeFileSync('.private/read-diagnostic.json',JSON.stringify({header:rows[0],reason:error.message}));throw error;}}
  async apply(plan,profile){
    if(!await this.isEditable())throw Error('document_read_only_or_login_required');
    // 全部前提检查完再开始写。之后逐项核对，任何异常交由结果核对流程。
    if(await this.readCell(column(plan.nameCol)+plan.identityRow)!==profile.name || await this.readCell(column(plan.studentCol)+plan.identityRow)!==profile.student_id)throw Error('identity_changed');
    for(const change of plan.changes){if(await this.readCell(column(change.col)+change.row)!==change.before)throw Error('target_changed');}
    for(const change of plan.changes){
      await this.select(column(change.col)+change.row);
      // 向网格键入普通文本，平台负责保存；模型没有自由点击权限。
      const editor=this.page.locator('#alloy-simple-text-editor');
      await editor.fill(change.value);
      await editor.press('Enter');
      if(await this.readCell(column(change.col)+change.row)!==change.value)throw Error('write_not_verified');
    }
  }
  // 任意表头版本的写入：写前重新读整表核对身份和目标原值，写后逐格回读并整体校验。
  async applyGeneral(plan,profile){
    if(!await this.isEditable())throw Error('document_read_only_or_login_required');
    const grid=await this.readUsedRange();
    assertWritePreconditions(plan,grid,profile);
    for(const change of plan.changes){
      const address=column(change.col)+change.row;
      await this.select(address);
      const editor=this.page.locator('#alloy-simple-text-editor');
      await editor.fill(change.value);
      await editor.press('Enter');
      if((await this.readCell(address)).trim()!==change.value)throw Error('write_not_verified');
    }
    // 全部写完后再整体回读一次，避免只看单格而漏掉行位移或并发修改。
    const after=await this.readUsedRange();
    if(!changesMatch(plan,after))throw Error('readback_mismatch');
  }
  async verifyGeneral(plan){const grid=await this.readUsedRange();return changesMatch(plan,grid);}
  async verify(profile){const p=await this.prepare(profile);return p.changes.length===0;}
  async close(){if(this.context)await this.context.close();}
}
module.exports={TencentSheet,column};
