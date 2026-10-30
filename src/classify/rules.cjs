// 确定性规则优先：文档链接、行动关键词、短聊天、未分类。
// 规则结果是候选生成的输入；真正是否行动仍由用户确认。
const ACTION_PATTERN=/(报名|填写|收集|统计|接龙|问卷|作业|考试|截止|提交|名单|登记|确认|参加|会议|讲座)/;

function classifyMessage({text='',links=[]}={}){
  const normalized=String(text||'').trim();
  if(Array.isArray(links)&&links.length){
    return {category:'form',confidence:0.95,rule:'has_document_link'};
  }
  if(ACTION_PATTERN.test(normalized)){
    return {category:'action',confidence:0.8,rule:'action_keywords'};
  }
  if(normalized.length<=20){
    return {category:'chat',confidence:0.6,rule:'short_chat'};
  }
  return {category:'unknown',confidence:0.4,rule:'unclassified'};
}

function shouldSuggest(category){
  return category==='form'||category==='action'||category==='unknown';
}

module.exports={classifyMessage,shouldSuggest,ACTION_PATTERN};
