const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

function canonicalUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.hostname !== 'docs.qq.com' || u.port || u.username || u.password || !/^\/sheet\/[A-Za-z0-9_-]+$/.test(u.pathname)) throw Error('unsupported_document');
  const tab = u.searchParams.get('tab');
  return u.origin + u.pathname + (tab ? '?tab=' + encodeURIComponent(tab) : '');
}
function extractLinks(event) {
  const text = JSON.stringify(event.message ?? event.raw_message ?? '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const links = text.match(/https:\/\/docs\.qq\.com\/sheet\/[A-Za-z0-9_-]+(?:\?[^\s"<>\\]*)?/g) || [];
  return [...new Set(links.map(url => { try { return canonicalUrl(url); } catch { return null; } }).filter(Boolean))];
}
function sourceMatches(event, source) {
  if(source.account_id && String(event.self_id)!==source.account_id)return false;
  if (event.post_type !== 'message' || !source.id) return false;
  if (source.type === 'private') return event.message_type === 'private' && String(event.user_id) === source.id;
  return event.message_type === 'group' && String(event.group_id) === source.id && (!source.sender_id || String(event.user_id) === source.sender_id);
}
function buildPlan(rows, profile) {
  const fields = ['姓名','学号','性别','年龄'];
  const header = rows.findIndex(row => fields.every(f => row.includes(f)));
  if (header < 0) throw Error('unsupported_header');
  const cols = fields.map(f => rows[header].indexOf(f));
  if(fields.some(f=>rows[header].filter(x=>x===f).length!==1)) throw Error('ambiguous_header');
  const matches = rows.map((row,index)=>({row,index})).filter(x=>x.index>header && x.row[cols[0]]===profile.name && x.row[cols[1]]===profile.student_id);
  if(matches.length!==1) throw Error('identity_not_unique');
  const own = matches[0];
  const changes=[];
  for(const [field,value] of [['性别',profile.sex],['年龄',String(profile.age)]]) {
    const col=rows[header].indexOf(field), before=own.row[col] || '';
    if(before && before!==value) throw Error('existing_value_conflict');
    if(!before) changes.push({row:own.index+1,col:col+1,field,before,value});
  }
  return {header:header+1,identityRow:own.index+1,nameCol:cols[0]+1,studentCol:cols[1]+1,changes};
}
function openStore(file) {
  const db=new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS profile(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,student_id TEXT NOT NULL,sex TEXT NOT NULL,age INTEGER NOT NULL,provided_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_fields(key TEXT PRIMARY KEY,value TEXT NOT NULL,source TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY,source_key TEXT NOT NULL,url TEXT NOT NULL,state TEXT NOT NULL,plan TEXT,error TEXT,updated_at TEXT NOT NULL,UNIQUE(source_key,url));`);
  return {
    db,
    profile(){const p=db.prepare('SELECT * FROM profile WHERE id=1').get();if(!p)throw Error('profile_missing');return p;},
    saveProfile(p){db.prepare('INSERT OR REPLACE INTO profile VALUES(1,?,?,?,?,?)').run(p.name,String(p.student_id),p.sex,p.age,new Date().toISOString());},
    // 键值字段用于任意表头映射；旧 profile 行继续作为姓名/学号等基础字段的默认来源。
    fields(){
      const out={};
      for(const row of db.prepare('SELECT key,value FROM profile_fields').all())out[row.key]=row.value;
      const p=db.prepare('SELECT * FROM profile WHERE id=1').get();
      if(p){
        if(out.name===undefined)out.name=p.name;
        if(out.student_id===undefined)out.student_id=p.student_id;
        if(out.sex===undefined)out.sex=p.sex;
        if(out.age===undefined)out.age=String(p.age);
      }
      return out;
    },
    setField(key,value,source='manual'){
      db.prepare('INSERT OR REPLACE INTO profile_fields(key,value,source,updated_at) VALUES(?,?,?,?)')
        .run(String(key),String(value),String(source),new Date().toISOString());
    },
    listFields(){
      return db.prepare('SELECT key,source,updated_at,length(value) AS value_length FROM profile_fields ORDER BY key').all();
    },
    enqueue(key,url){return db.prepare("INSERT OR IGNORE INTO runs(source_key,url,state,updated_at) VALUES(?,?,'received',?)").run(key,url,new Date().toISOString()).changes===1;},
    update(id,state,plan,error=null){db.prepare('UPDATE runs SET state=?,plan=COALESCE(?,plan),error=?,updated_at=? WHERE id=?').run(state,plan ? JSON.stringify(plan):null,error,new Date().toISOString(),id);},
    recover(){db.exec("UPDATE runs SET state='outcome_unknown',error='interrupted_write' WHERE state='writing'; UPDATE runs SET state='received' WHERE state='prepared';");},
    summary(){return db.prepare('SELECT id,state,error,updated_at FROM runs ORDER BY id').all();}
  };
}
function eventKey(e) {
  if(e.message_id===undefined || e.self_id===undefined)throw Error('stable_message_id_missing');
  return [e.self_id,e.message_type,e.group_id??e.user_id,e.message_id].map(String).join(':');
}
function digest(plan) {return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');}

// 腾讯文档复制出来的区域是 TSV；单元格内的换行和制表符用双引号包裹。
// 这里只做结构解析，不解释单元格含义，也不做任何写操作。
function parseTsv(text) {
  const rows=[];let row=[];let cell='';let quoted=false;
  const pushRow=()=>{row.push(cell);rows.push(row);row=[];cell='';};
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){
      if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}
      else cell+=ch;
    }else if(ch==='"')quoted=true;
    else if(ch==='\t'){row.push(cell);cell='';}
    else if(ch==='\n')pushRow();
    else if(ch==='\r'){} // 兼容 Windows 换行
    else cell+=ch;
  }
  if(cell!==''||row.length)pushRow();
  // 剪贴板常带有末尾空行；去掉它们，但保留中间的空单元格。
  while(rows.length&&rows[rows.length-1].every(value=>value===''))rows.pop();
  return rows;
}
function text(value){return String(value??'').trim();}

// 以姓名和学号同时精确匹配定位本人行；不把昵称、模糊匹配或第一条命中当作身份。
function findIdentityRow(grid,profile) {
  const name=text(profile.name),studentId=text(profile.student_id);
  const candidates=[];
  grid.forEach((row,rowIndex)=>{
    const nameCols=[],studentCols=[];
    row.forEach((value,col)=>{if(text(value)===name)nameCols.push(col);if(text(value)===studentId)studentCols.push(col);});
    if(nameCols.length&&studentCols.length)candidates.push({rowIndex,nameCols,studentCols});
  });
  if(!candidates.length)return null;
  if(candidates.length!==1)throw Error('identity_not_unique');
  const candidate=candidates[0];
  // 同一行内出现多个姓名或学号单元格时，无法判断哪一列才是身份列。
  if(candidate.nameCols.length!==1||candidate.studentCols.length!==1)throw Error('identity_columns_ambiguous');
  return {rowIndex:candidate.rowIndex,nameCol:candidate.nameCols[0],studentCol:candidate.studentCols[0]};
}

// 表头取本人行上方、非空单元格最多的一行；这能跳过合并标题或说明行。
// 多行表头、分区表头仍需人工确认，当前版本不自动猜测。
function findHeaderRow(grid,identityRowIndex) {
  let best=null;
  for(let rowIndex=0;rowIndex<identityRowIndex;rowIndex++){
    const score=grid[rowIndex].filter(value=>text(value)!=='').length;
    if(score<2)continue;
    if(!best||score>best.score||(score===best.score&&rowIndex>best.rowIndex))best={rowIndex,score};
  }
  if(!best)throw Error('header_not_found');
  return best.rowIndex;
}

// 没有完整身份行时，用非空单元格最多的一行作为表头候选；并列时取更靠上的行。
function findHeaderRowByContent(grid) {
  let best=null;
  grid.forEach((row,rowIndex)=>{
    const score=row.filter(value=>text(value)!=='').length;
    if(score<2)return;
    if(!best||score>best.score||(score===best.score&&rowIndex<best.rowIndex))best={rowIndex,score};
  });
  if(!best)throw Error('header_not_found');
  return best.rowIndex;
}
// 部分身份：姓名已存在、学号单元格为空且姓名在表中唯一。
// 这种情况不自动当作完整身份，调用方必须把 name_only 明确展示给用户确认。
function findPartialIdentityRow(grid,profile,headerRow) {
  const name=text(profile.name),studentId=text(profile.student_id);
  if(!name||!studentId)return null;
  const header=grid[headerRow]||[];
  const studentCols=header.map((value,col)=>({header:text(value),col}))
    .filter(item=>/学号|学生编号|学籍号/.test(item.header));
  if(studentCols.length!==1)return null;
  const studentCol=studentCols[0].col;
  const candidates=[];
  grid.forEach((row,rowIndex)=>{
    if(rowIndex===headerRow)return;
    const nameCols=[];
    row.forEach((value,col)=>{if(text(value)===name)nameCols.push(col);});
    if(nameCols.length!==1)return;
    if(row.some(value=>text(value)===studentId))return;
    if(text(row[studentCol])!=='')return;
    candidates.push({rowIndex,nameCol:nameCols[0],studentCol,mode:'name_only'});
  });
  if(!candidates.length)return null;
  if(candidates.length!==1)throw Error('identity_not_unique');
  return candidates[0];
}

// 任意表头版本的填表计划：模型只提供“列 -> 本地字段 key”的映射，
// 字段值和目标行由程序从本地数据库与已识别的本人行计算，模型不提供单元格值。
function buildGeneralPlan({grid,identity,headerRow,mappings,fields}) {
  const header=grid[headerRow]||[];
  const ownRow=grid[identity.rowIndex]||[];
  const columns=[],changes=[],missing=[],warnings=[];const seenFields=new Set();
  for(const mapping of mappings){
    const column=Number(mapping.column),field=mapping.field;
    if(!Number.isInteger(column)||column<1||column>header.length)throw Error('mapping_out_of_range');
    if(typeof field!=='string'||!Object.prototype.hasOwnProperty.call(fields,field))throw Error('unknown_profile_field');
    if(seenFields.has(field))throw Error('duplicate_field');
    seenFields.add(field);
    // 身份列不能被映射成别的字段，别的列也不能冒充姓名或学号。
    if(column-1===identity.nameCol&&field!=='name')throw Error('identity_column_mismatch');
    if(column-1===identity.studentCol&&field!=='student_id')throw Error('identity_column_mismatch');
    if(field==='name'&&column-1!==identity.nameCol)throw Error('identity_column_mismatch');
    if(field==='student_id'&&column-1!==identity.studentCol)throw Error('identity_column_mismatch');
    const headerCell=text(header[column-1]);
    const value=fields[field];
    columns.push({column,field,header:headerCell});
    if(value===undefined||value===null||text(value)===''){
      missing.push({column,header:headerCell,field,reason:'profile_value_missing'});
      continue;
    }
    const before=text(ownRow[column-1]);
    const after=text(value);
    if(before!==''){
      if(before!==after)throw Error('existing_value_conflict');
      continue; // 已有值与数据库一致，不需要重复写。
    }
    const change={row:identity.rowIndex+1,col:column,field,before:'',value:after};
    changes.push(change);
    // 公式起始字符可能被平台当成公式执行；先标记，写入前必须单独处理。
    if(/^[=+\-@]/.test(after))warnings.push({row:change.row,col:column,field,reason:'formula_like_value'});
  }
  return {
    headerRow:headerRow+1,
    identityRow:identity.rowIndex+1,
    identityMode:identity.mode||'full',
    nameCol:identity.nameCol+1,
    studentCol:identity.studentCol+1,
    columns,changes,missing,warnings
  };
}

// 写入前重新读取整张表后调用：身份行必须仍在同一位置，目标单元格必须仍为空。
function assertWritePreconditions(plan,grid,profile) {
  const identity=findIdentityRow(grid,profile);
  if(identity){
    if(identity.rowIndex+1!==plan.identityRow)throw Error('identity_changed');
  }else if(plan.identityMode==='name_only'){
    // 部分身份写入前：姓名仍在本行，且学号单元格仍为空。
    const row=grid[plan.identityRow-1]||[];
    if(text(row[plan.nameCol-1])!==text(profile.name))throw Error('identity_changed');
    if(text(row[plan.studentCol-1])!=='')throw Error('identity_changed');
  }else throw Error('identity_changed');
  for(const change of plan.changes){
    const before=text(grid[change.row-1]?.[change.col-1]);
    if(before!==text(change.before))throw Error('target_changed');
  }
  return true;
}
// 写入后回读：只检查计划中的目标单元格是否等于数据库值。
function changesMatch(plan,grid) {
  return plan.changes.every(change=>text(grid[change.row-1]?.[change.col-1])===text(change.value));
}

module.exports={canonicalUrl,extractLinks,sourceMatches,buildPlan,openStore,eventKey,digest,
  parseTsv,findIdentityRow,findHeaderRow,findHeaderRowByContent,findPartialIdentityRow,
  buildGeneralPlan,assertWritePreconditions,changesMatch};
