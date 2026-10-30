// 只读判断页面是否处于“未登录/不可编辑”状态；不尝试自动登录或绕过验证码。
async function loginRequired(sheet){
  if(typeof sheet.isEditable!=='function')return false;
  if(await sheet.isEditable())return false;
  const page=sheet.page;
  if(!page||typeof page.getByRole!=='function')return true;
  return await page.getByRole('button',{name:'登录腾讯文档',exact:true}).isVisible().catch(()=>false);
}

module.exports={loginRequired};
