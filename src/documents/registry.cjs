// 文档执行器注册表：腾讯文档已实现，WPS/金山和飞书只保留识别接口。
// 新平台接入时实现 inspect/prepare/apply/verify，再把 implemented 设为 true。
const {canonicalUrl}=require('../core.cjs');

const ADAPTERS=[
  {
    id:'tencent_sheet',
    label:'腾讯文档',
    implemented:true,
    match:url=>/^https:\/\/docs\.qq\.com\/sheet\/[A-Za-z0-9_-]+/.test(String(url||'')),
    normalize:url=>canonicalUrl(url)
  },
  {
    id:'wps_sheet',
    label:'WPS / 金山文档',
    implemented:false,
    match:url=>/^https:\/\/(?:www\.)?(?:kdocs|wps)\.cn\//.test(String(url||'')),
    normalize:null
  },
  {
    id:'feishu_sheet',
    label:'飞书表格',
    implemented:false,
    match:url=>/^https:\/\/(?:[a-z0-9-]+\.)?feishu\.cn\//.test(String(url||'')),
    normalize:null
  }
];

function detectDocumentAdapter(url){
  return ADAPTERS.find(adapter=>adapter.match(url))||null;
}

function findDocumentAdapter(id){
  return ADAPTERS.find(adapter=>adapter.id===id)||null;
}

function assertAdapterImplemented(id){
  const adapter=findDocumentAdapter(id);
  if(!adapter)throw Error('document_adapter_unknown');
  if(!adapter.implemented)throw Error('document_adapter_not_implemented');
  return adapter;
}

module.exports={ADAPTERS,detectDocumentAdapter,findDocumentAdapter,assertAdapterImplemented};
