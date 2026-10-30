// 文档身份定位：用可扩展的“身份标识集合”匹配本人行。
// 目前姓名是弱标识、学号是强标识；后续可以在这里增加邮箱、手机号等字段。
const {
  findHeaderRowByContent,
  findReservedIdentity
}=require('../core.cjs');

const text=value=>String(value??'').trim();

const IDENTIFIERS=[
  {key:'student_id',header:/学号|学生编号|学籍号/,strength:'strong'},
  {key:'name',header:/姓名|名字|学生姓名/,strength:'weak'}
];

function headerColumns(grid,headerRow){
  const columns={};
  for(const identifier of IDENTIFIERS){
    const matches=(grid[headerRow]||[])
      .map((value,index)=>({value,index}))
      .filter(item=>identifier.header.test(text(item.value)))
      .map(item=>item.index);
    if(matches.length>1)throw Error('identity_columns_ambiguous');
    if(matches.length===1)columns[identifier.key]=matches[0];
  }
  return columns;
}

function findIdentityColumns(header){
  const columns={};
  for(const identifier of IDENTIFIERS){
    const matches=(header||[])
      .map((value,index)=>({value,index}))
      .filter(item=>identifier.header.test(text(item.value)))
      .map(item=>item.index);
    if(matches.length!==1)return null;
    columns[identifier.key]=matches[0];
  }
  return columns.name!==undefined&&columns.student_id!==undefined?columns:null;
}

function candidateRows(grid,profile,headerRow,columns){
  if(columns.name===undefined||columns.student_id===undefined)return null;
  const name=text(profile.name),studentId=text(profile.student_id);
  const candidates=[],conflicts=[];
  for(let rowIndex=headerRow+1;rowIndex<grid.length;rowIndex++){
    const row=grid[rowIndex]||[];
    const cellName=text(row[columns.name]);
    const cellStudent=text(row[columns.student_id]);
    const nameMatch=name!==''&&cellName===name;
    const studentMatch=studentId!==''&&cellStudent===studentId;
    if(nameMatch&&studentMatch){
      candidates.push({rowIndex,nameCol:columns.name,studentCol:columns.student_id,mode:'full'});
    }else if(studentMatch&&cellName===''){
      // 只有学号、姓名格为空：用学号定位现有行，审批时把姓名补上。
      candidates.push({rowIndex,nameCol:columns.name,studentCol:columns.student_id,mode:'student_id_only'});
    }else if(nameMatch&&cellStudent===''){
      // 姓名唯一、学号为空：沿用原来的部分身份规则。
      candidates.push({rowIndex,nameCol:columns.name,studentCol:columns.student_id,mode:'name_only'});
    }else if((studentMatch&&cellName!=='')||(nameMatch&&cellStudent!=='')){
      // 同一个学号/姓名出现在另一行但另一个标识不一致，不能猜。
      conflicts.push(rowIndex);
    }
  }
  if(conflicts.length)throw Error('identity_conflict');
  if(candidates.length>1)throw Error('identity_not_unique');
  return candidates[0]||null;
}

function resolveIdentity(grid,profile,reservation){
  if(reservation){
    const reserved=findReservedIdentity(grid,profile,reservation);
    if(reserved)return {identity:reserved,headerRow:Number(reservation.header_row)-1,identityMode:'reserved'};
  }
  let headerRow;
  try{headerRow=findHeaderRowByContent(grid);}
  catch{return null;}
  const columns=headerColumns(grid,headerRow);
  const candidate=candidateRows(grid,profile,headerRow,columns);
  if(!candidate)return null;
  return {identity:candidate,headerRow,identityMode:candidate.mode};
}

// 新文档没有本人行时，计划写到已有内容之后的下一行。
// 这里只做只读定位；真正插入/写入仍要经过审批和执行阶段。
function resolveNewRowIdentity(grid){
  let headerRow;
  try{headerRow=findHeaderRowByContent(grid);}
  catch{return null;}
  const columns=findIdentityColumns(grid[headerRow]);
  if(!columns)return null;
  return {
    identity:{rowIndex:grid.length,nameCol:columns.name,studentCol:columns.student_id,mode:'new_row'},
    headerRow,
    identityMode:'new_row'
  };
}

module.exports={IDENTIFIERS,resolveIdentity,resolveNewRowIdentity,findIdentityColumns};
