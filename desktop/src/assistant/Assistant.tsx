import {useCallback, useEffect, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {readCredentials} from '../api';
import {isTauriApp} from '../secure';
import Research from './Research';
import PythonWorkspace from './PythonWorkspace';
import SheetWorkspace from './SheetWorkspace';
import type {SheetTaskRenderer} from './SheetWorkspace';
import type {EffortPresets} from './Research';
import './assistant.css';

type Root = {id: string; path: string};
type Entry = {name: string; directory: boolean};
type Document = {id: string; name: string; rootId: string | null; status: string; text?: string; kind?: 'file' | 'todo'};
type Evidence = {id: string; title: string; locator: string; quote: string};
type Result = {status: string; answer?: string; supplement?: string; limited?: boolean; evidence: Evidence[];
  activity?: {name: string; status: string; taskId?: number}[]};
type Session = {id: string; state: string; turns: {id: string; question: string; result?: Result}[]};
type Preview = {id: string; digest: string; details: {
  kind: string; path?: string; label?: string; name?: string; target?: string; blob?: string;
  key?: string; before?: string | null; value?: string | null;
  items?: {id: number; title: string; messages: {id: number; text: string | null}[]}[];
  rows?: {name: string; sha256: string; bytes: number; chunks: number; unchanged: boolean; before?: string; text?: string; target: string}[];
}};
type Model = {id: string; label: string};

const formats = /\.(md|txt|docx|pdf|png|jpe?g)$/i;
const feedback: Record<string, string> = {
  no_evidence: '知识库没有找到能支持这个问题的资料。',
  local_evidence: '本机检索结果',
  cloud_grant_required: '以下是本机资料。生成模型回答需要先授权对应资料。',
  model_failed: '模型请求失败，可继续查看本机检索结果。',
  model_unavailable: '所选模型暂不可用。',
  sheet_queued: '填写计划已进入只读准备。可以到工作区填表查看和审批。',
  tool_budget_exhausted: '本轮工具问答已达到预算上限。',
  preview_changed: '目标已变化，请重新预览。',
  profile_busy: '正在写表或回读，完成后再更新个人资料。',
  source_changed: '来源已变化，请重新提问。',
  todo_unavailable: '待办状态已变化，请刷新后重试。',
  outside_scope: '该资源不在当前授权范围内。',
  assistant_unavailable: '助手服务尚未启用。',
  not_found: '资源不存在，或助手服务尚未启用。',
  unauthorized: '请检查独立的知识库访问令牌。',
  busy: '当前请求较多，请稍后重试。'
};
let browserToken = '';

async function api<T>(token: string, route: string, body?: unknown): Promise<T> {
  const base = readCredentials().base.replace(/\/+$/, '');
  // 独立助手凭证只发送给回环主机或本地 Vite 代理。
  if (base !== '/api' && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('outside_scope');
  const response = await fetch(base + '/v1/assistant' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    cache: 'no-store', redirect: 'error',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw Error(payload.error?.code || payload.error || 'assistant_unavailable');
  return payload.data;
}

function message(error: unknown) {
  const code = error instanceof Error ? error.message : 'assistant_unavailable';
  return feedback[code] || '助手操作失败（' + code + '）。';
}

type TodoItem = {id: number; title: string; admitted: number};
type Field = {key: string; value: string};
const profileLabels: Record<string, string> = {name: '姓名', student_id: '学号', sex: '性别', age: '年龄', major: '专业', phone: '电话', email: '邮箱'};

type AssistantProps = {
  candidate?: number; onCandidateDone?: () => void; renderSheetTask: SheetTaskRenderer;
};

export default function Assistant(props: AssistantProps) {
  const [legacy, setLegacy] = useState(false);
  const showLegacy = legacy || props.candidate !== undefined;
  return <div className="stack">
    <div className="assistant-actions">
      <button className="button" type="button" disabled={!showLegacy} onClick={() => {
        props.onCandidateDone?.(); setLegacy(false);
      }}>Python 知识工作台</button>
      <button className="button" type="button" disabled={showLegacy} onClick={() => setLegacy(true)}>旧版资料管理与工具</button>
    </div>
    {showLegacy ? <LegacyAssistant {...props} /> : <PythonWorkspace />}
  </div>;
}

function LegacyAssistant({candidate, onCandidateDone, renderSheetTask}: AssistantProps) {
  const [token, setToken] = useState(browserToken);
  const [tokenDraft, setTokenDraft] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [effortPresets, setEffortPresets] = useState<EffortPresets>();
  const [showResearch, setShowResearch] = useState(false);
  const [sheetsEnabled, setSheetsEnabled] = useState(false);
  const [toolsAvailable, setToolsAvailable] = useState(false);
  const [enableTools, setEnableTools] = useState(false);
  const [toolTarget, setToolTarget] = useState('');
  const [model, setModel] = useState('');
  const [useModel, setUseModel] = useState(false);
  const [roots, setRoots] = useState<Root[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  const [root, setRoot] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entryNext, setEntryNext] = useState<number | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [docOffset, setDocOffset] = useState(0);
  const [draft, setDraft] = useState({id: '', name: '', text: ''});
  const [question, setQuestion] = useState('');
  const [session, setSession] = useState<Session>();
  const [reference, setReference] = useState<Evidence>();
  const [preview, setPreview] = useState<Preview>();
  const [decisionId, setDecisionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoSelection, setTodoSelection] = useState<number[]>([]);
  const [profile, setProfile] = useState<Field[]>([]);
  const [fieldDraft, setFieldDraft] = useState<Field>({key: '', value: ''});
  const researchRequest = useCallback(<T,>(route: string, body?: unknown) => api<T>(token, route, body), [token]);

  async function refresh(credentials: string, offset = 0) {
    const [cap, folders, knowledge, chats, cloud, openTodos, fields] = await Promise.all([
      api<{models: Model[]; effortPresets: EffortPresets; sheets?: boolean; tools?: boolean}>(credentials, '/capabilities'),
      api<{items: Root[]}>(credentials, '/roots'),
      api<{items: Document[]}>(credentials, '/knowledge?offset=' + offset),
      api<{items: {id: string}[]}>(credentials, '/sessions'),
      api<{items: {target: string}[]}>(credentials, '/grants'),
      api<{items: TodoItem[]}>(credentials, '/todos'),
      api<{items: Field[]}>(credentials, '/profile')
    ]);
    setModels(cap.models);
    setEffortPresets(cap.effortPresets);
    setSheetsEnabled(!!cap.sheets);
    setToolsAvailable(!!cap.tools);
    setModel(old => cap.models.some(entry => entry.id === old) ? old : cap.models[0]?.id || '');
    setRoots(folders.items);
    setDocs(knowledge.items);
    setGrants(cloud.items.map(item => item.target));
    setTodos(openTodos.items);
    setProfile(fields.items);
    setDocOffset(offset);
    if (chats.items.length) setSession(await api<Session>(credentials, '/sessions/' + chats.items.at(-1)?.id));
  }

  useEffect(() => {
    if (!isTauriApp()) return;
    invoke<string | null>('get_assistant_token').then(saved => { if (saved) setToken(saved); })
      .catch(error => setNotice(message(error)));
  }, []);

  useEffect(() => {
    if (token) void refresh(token).catch(error => setNotice(message(error)));
  }, [token]);

  useEffect(() => {
    if (!token || !session || session.state !== 'running') return;
    let alive = true;
    const timer = window.setInterval(() => {
      void api<Session>(token, '/sessions/' + session.id).then(updated => {
        if (alive) setSession(updated);
      }).catch(error => { if (alive) setNotice(message(error)); });
    }, 700);
    return () => { alive = false; window.clearInterval(timer); };
  }, [token, session?.id, session?.state]);

  async function run(work: () => Promise<void>) {
    setNotice('');
    setBusy(true);
    try { await work(); } catch (error) { setNotice(message(error)); } finally { setBusy(false); }
  }

  async function review(body: unknown) {
    if (preview) throw Error('preview_pending');
    const result = await api<Preview>(token, '/previews', body);
    setPreview(result);
    setDecisionId(crypto.randomUUID());
  }

  async function openFolder(id: string, folder = '', offset = 0) {
    const listing = await api<{items: Entry[]; next: number | null}>(token,
      '/roots/' + id + '/entries?directory=' + encodeURIComponent(folder) + '&offset=' + offset);
    setRoot(id);
    setDirectory(folder);
    setEntries(listing.items);
    setEntryNext(listing.next);
    if (!offset) setSelected([]);
  }

  return (
    <div className="stack assistant-page">
      <form className="settings-card" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const value = tokenDraft.trim();
          await api(value, '/capabilities');
          if (isTauriApp()) await invoke('save_assistant_token', {token: value});
          else browserToken = value;
          setToken(value);
          setTokenDraft('');
          await refresh(value);
        });
      }}>
        <h2>本机知识库连接</h2>
        <label>独立知识库令牌<input type="password" value={tokenDraft} onChange={event => setTokenDraft(event.target.value)} autoComplete="off" /></label>
        <div className="assistant-actions">
          <button className="button" disabled={busy || !tokenDraft.trim()}>连接</button>
          <button type="button" className="button" disabled={busy || !token} onClick={() => void run(async () => {
            if (isTauriApp()) await invoke('delete_assistant_token');
            browserToken = '';
            setToken(''); setSession(undefined); setPreview(undefined); setReference(undefined);
            setDocs([]); setRoots([]); setEntries([]); setModels([]); setGrants([]); setRoot('');
            setShowResearch(false); setEffortPresets(undefined);
          })}>忘记令牌</button>
        </div>
      </form>
      {notice && <div className="callout" role="status">{notice}</div>}
      {token && <>
        {sheetsEnabled && <SheetWorkspace request={researchRequest} renderTask={renderSheetTask} />}
        <div className="assistant-actions">
          <button className="button" onClick={() => setShowResearch(false)}>普通问答</button>
          <button className="button" disabled={!effortPresets} onClick={() => setShowResearch(true)}>Deeper Research</button>
        </div>
        {showResearch && effortPresets && <Research request={researchRequest} models={models} sources={docs}
          presets={effortPresets} pendingPreview={!!preview} save={async (id, name, includeProcess) => {
            if (preview) throw Error('preview_pending');
            setPreview(await api<Preview>(token, '/research/' + id + '/save-preview', {name, includeProcess}));
            setDecisionId(crypto.randomUUID());
          }} />}
        {!showResearch && <section className="settings-card">
          <h2>普通问答</h2>
          <label>模型<select value={model} onChange={event => setModel(event.target.value)}>
            {models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
          <label className="assistant-checkbox"><input type="checkbox" checked={useModel} onChange={event => setUseModel(event.target.checked)} />
            使用模型整理已授权资料
          </label>
          {useModel && toolsAvailable && <label className="assistant-checkbox">
            <input type="checkbox" checked={enableTools} onChange={event => setEnableTools(event.target.checked)} />
            允许模型调用本轮授权的查询与准备工具
          </label>}
          {useModel && toolsAvailable && enableTools && sheetsEnabled && <label>
            本轮可准备的腾讯表格（可选）
            <input value={toolTarget} onChange={event => setToolTarget(event.target.value)} maxLength={2048} />
          </label>}
          <form onSubmit={event => {
            event.preventDefault();
            void run(async () => {
              const value = session || await api<Session>(token, '/sessions', {});
              const tools = useModel && toolsAvailable && enableTools;
              await api(token, '/sessions/' + value.id + '/turns', {question, modelId: model, useModel, enableTools: tools,
                toolTarget: tools && sheetsEnabled && toolTarget.trim() ? toolTarget.trim() : undefined,
                clientRequestId: crypto.randomUUID()});
              setSession(await api<Session>(token, '/sessions/' + value.id));
              setQuestion('');
            });
          }}>
            <label>问题<textarea value={question} onChange={event => setQuestion(event.target.value)} maxLength={2048} /></label>
            <button className="button primary" disabled={busy || !question.trim() || session?.state === 'running'}>提问</button>
            {session && <button className="button" type="button" disabled={busy} onClick={() => void run(async () => {
              await api(token, '/sessions/' + session.id + '/close', {});
              setSession(undefined); setReference(undefined);
            })}>关闭对话</button>}
          </form>
          {session?.turns.map(turn => <article key={turn.id} className="assistant-turn">
            <strong>{turn.question}</strong>
            {!turn.result && <p>正在检索或生成…</p>}
            {turn.result && <>
              <p className="assistant-text">{turn.result.answer || feedback[turn.result.status] || turn.result.status}</p>
              {turn.result.supplement && <p>模型补充 · {turn.result.supplement}</p>}
              {turn.result.limited && <p>模型回答仅覆盖本次获授权且纳入上下文的资料。</p>}
              {turn.result.activity?.map((item, index) => <p key={index}>
                {item.taskId ? '填表任务 #' + item.taskId + ' 已排队，等待查看与审批。' : '工具 · ' + item.name + ' · ' + item.status}
              </p>)}
              {turn.result.evidence.map(item => <button className="button assistant-source" key={item.id} onClick={() =>
                void run(async () => setReference(await api<Evidence>(token, '/evidence/' + item.id)))}>
                {item.title} · {item.locator}
              </button>)}
            </>}
          </article>)}
          {reference && <div className="assistant-turn"><strong>{reference.title} · {reference.locator}</strong><p className="assistant-text">{reference.quote}</p>
            <button className="button" onClick={() => setReference(undefined)}>收起引用</button></div>}
        </section>}
        <section className="settings-card">
          <h2>待办纳入知识库</h2>
          <button className="button" disabled={busy} onClick={() => void run(() => refresh(token, docOffset))}>刷新待办与资料</button>
          {candidate !== undefined && <div className="assistant-actions">
            <button className="button primary" disabled={busy || !!preview} onClick={() => void run(() =>
              review({kind: 'accept_todo', suggestionId: candidate}))}>预览保留并纳入</button>
            <button className="button" onClick={onCandidateDone}>返回普通纳入</button>
          </div>}
          <div className="assistant-entries">{todos.map(todo => <div className="assistant-actions" key={todo.id}>
            <label className="assistant-checkbox"><input type="checkbox" checked={todoSelection.includes(todo.id)}
              disabled={!todoSelection.includes(todo.id) && todoSelection.length >= 16}
              onChange={event => setTodoSelection(items => event.target.checked ? [...items, todo.id] : items.filter(id => id !== todo.id))} />
              {todo.title} · 已纳入 {todo.admitted} 条来源</label>
            <button className="button" disabled={busy || !!preview} onClick={() => void run(() => review({
              kind: grants.includes('todo-' + todo.id) ? 'cloud_revoke' : 'cloud_grant', documentId: 'todo-' + todo.id
            }))}>{grants.includes('todo-' + todo.id) ? '撤销标题模型授权' : '预览标题模型授权'}</button>
          </div>)}</div>
          <button className="button" disabled={busy || !!preview || !todoSelection.length} onClick={() => void run(() =>
            review({kind: 'admit_todos', todoIds: todoSelection}))}>预览批量纳入</button>
        </section>
        <section className="settings-card">
          <h2>个人资料</h2>
          {profile.map(field => <div key={field.key} className="assistant-actions">
            <span>{profileLabels[field.key] || field.key} · {field.value}</span>
            <button className="button" onClick={() => setFieldDraft(field)}>编辑</button>
            <button className="button" disabled={busy || !!preview} onClick={() => void run(() =>
              review({kind: 'profile', key: field.key, value: null}))}>预览删除</button>
            <button className="button" disabled={busy || !!preview} onClick={() => void run(() => review({
              kind: grants.includes('profile-' + field.key) ? 'cloud_revoke' : 'cloud_grant', documentId: 'profile-' + field.key
            }))}>{grants.includes('profile-' + field.key) ? '撤销字段模型授权' : '预览字段模型授权'}</button>
          </div>)}
          <form onSubmit={event => {event.preventDefault(); void run(() => review({kind: 'profile', ...fieldDraft}));}}>
            <label>资料字段名<input value={fieldDraft.key} onChange={event => setFieldDraft({...fieldDraft, key: event.target.value})} /></label>
            <label>资料值<input value={fieldDraft.value} onChange={event => setFieldDraft({...fieldDraft, value: event.target.value})} /></label>
            <button className="button" disabled={busy || !!preview || !fieldDraft.key || !fieldDraft.value.trim()}>预览更新资料</button>
          </form>
        </section>
        <section className="settings-card">
          <h2>资料导入</h2>
          <form onSubmit={event => {event.preventDefault(); void run(() => review({kind: 'grant_root', path: rootPath}));}}>
            <label>本机目录或文件<input value={rootPath} onChange={event => setRootPath(event.target.value)} /></label>
            <button className="button" disabled={busy || !!preview || !rootPath.trim()}>预览授权</button>
          </form>
          {roots.map(item => <div className="assistant-actions" key={item.id}>
            <button className="button" disabled={busy} onClick={() => void run(() => openFolder(item.id))}>{item.path}</button>
            <button className="button" disabled={busy || !!preview} onClick={() => void run(() => review({kind: 'remove_root', rootId: item.id}))}>撤销读取</button>
            <button className="button" disabled={busy || !!preview} onClick={() => void run(() => review({
              kind: grants.includes(item.id) ? 'cloud_revoke' : 'cloud_grant', rootId: item.id
            }))}>{grants.includes(item.id) ? '撤销根范围的模型授权' : '预览根范围的模型授权'}</button>
          </div>)}
          {!!root && <>
            <p>{directory || '当前授权根'}</p>
            {directory && <button className="button" disabled={busy} onClick={() => void run(() => openFolder(root, directory.split('/').slice(0, -1).join('/')))}>返回上一级</button>}
            <div className="assistant-entries">{entries.map(entry => entry.directory ?
              <button className="button" key={entry.name} disabled={busy} onClick={() => void run(() => openFolder(root, entry.name))}>{entry.name}</button> :
              formats.test(entry.name) && <label key={entry.name} className="assistant-checkbox">
                <input type="checkbox" checked={selected.includes(entry.name)} disabled={!selected.includes(entry.name) && selected.length >= 16}
                  onChange={event => setSelected(items => event.target.checked ? [...items, entry.name] : items.filter(name => name !== entry.name))} />{entry.name}
              </label>)}</div>
            {entryNext !== null && <button className="button" disabled={busy} onClick={() => void run(() => openFolder(root, directory, entryNext))}>下一页条目</button>}
            <button className="button primary" disabled={busy || !!preview || !selected.length} onClick={() => void run(() =>
              review({kind: 'import', rootId: root, names: selected}))}>预览导入 {selected.length} 份</button>
          </>}
        </section>
        <section className="settings-card">
          <h2>知识库资料</h2>
          {docs.map(doc => <div key={doc.id} className="assistant-doc">
            <strong>{doc.name}</strong><span>{doc.status === 'stale' ? '需要核对来源' : doc.status === 'empty' ? '无可索引内容' : '可检索'}</span>
            <div className="assistant-actions">
              {!doc.rootId && doc.kind !== 'todo' && <button className="button" disabled={busy || !!preview} onClick={() => void run(async () => {
                const detail = await api<Document>(token, '/knowledge/' + doc.id);
                setDraft({id: doc.id, name: doc.name, text: detail.text || ''});
              })}>编辑笔记</button>}
              {doc.kind !== 'todo' && <button className="button" disabled={busy || !!preview} onClick={() => void run(() => review({kind: 'trash', documentId: doc.id}))}>预览移入垃圾文件夹</button>}
              <button className="button" disabled={busy || !!preview} onClick={() => void run(() => review({
                kind: grants.includes(doc.id) ? 'cloud_revoke' : 'cloud_grant', documentId: doc.id
              }))}>{grants.includes(doc.id) ? '撤销资料模型授权' : '预览资料模型授权'}</button>
              {doc.rootId && grants.includes(doc.rootId) && <span>已继承目录授权</span>}
            </div>
          </div>)}
          {docOffset > 0 && <button className="button" disabled={busy} onClick={() => void run(() => refresh(token, Math.max(docOffset - 100, 0)))}>上一页资料</button>}
          {docs.length === 100 && <button className="button" disabled={busy} onClick={() => void run(() => refresh(token, docOffset + 100))}>下一页资料</button>}
          <form onSubmit={event => {event.preventDefault(); void run(() => review({kind: 'note', documentId: draft.id || undefined, name: draft.name, text: draft.text}));}}>
            <h3>{draft.id ? '编辑笔记' : '新建笔记'}</h3>
            <label>文件名<input placeholder="笔记.md" value={draft.name} onChange={event => setDraft({...draft, name: event.target.value})} /></label>
            <label>正文<textarea value={draft.text} onChange={event => setDraft({...draft, text: event.target.value})} /></label>
            <button className="button" disabled={busy || !!preview || !draft.name || !draft.text.trim()}>预览保存</button>
            {draft.id && <button className="button" type="button" onClick={() => setDraft({id: '', name: '', text: ''})}>新建另一份</button>}
          </form>
        </section>
      </>}
      {preview && <div className="modal-layer">
        <section className="modal assistant-approval" role="dialog" aria-modal="true" aria-label="知识库审批预览">
          <h2>确认变更预览</h2>
          <p>{({
            grant_root: '授权本机读取范围', remove_root: '撤销本机读取范围', cloud_grant: '允许配置的模型处理该资料命中的片段',
            cloud_revoke: '撤销云端处理授权', import: '保存副本、解析内容、检索索引与操作回执',
            note: '保存笔记版本、检索索引与操作回执', trash: '移动知识库副本并移出检索范围',
            accept_todo: '保留为待办并将以下来源纳入知识库', admit_todos: '纳入以下未完成待办的来源消息及索引',
            profile: '更新填表共用的个人资料，受影响的计划会重新准备'
          } as Record<string, string>)[preview.details.kind]}</p>
          <p>{preview.details.path || preview.details.label || preview.details.name}</p>
          {preview.details.key && <div className="assistant-turn">
            <strong>{profileLabels[preview.details.key] || preview.details.key}</strong>
            <p>原值 · {preview.details.before ?? '无'}</p><p>拟更新 · {preview.details.value ?? '删除'}</p>
          </div>}
          {preview.details.items?.map(item => <article key={item.id} className="assistant-turn">
            <strong>{item.title}</strong>
            {item.messages.map(source => <p key={source.id} className="assistant-text">来源 #{source.id} · {source.text || '无正文'}</p>)}
          </article>)}
          {preview.details.blob && <p>副本 · {preview.details.blob}</p>}
          {preview.details.target && <p>目标 · {preview.details.target}</p>}
          {preview.details.rows?.map(row => <article key={row.target} className="assistant-turn">
            <strong>{row.name}</strong><p>{row.unchanged ? '内容相同，复用已导入副本' : row.bytes + ' 字节 · ' + row.chunks + ' 个索引片段'}</p>
            {!row.unchanged && <><p>目标 · {row.target}</p><p>SHA-256 · {row.sha256}</p></>}
            {row.before !== undefined && <><strong>原内容</strong><p className="assistant-text">{row.before}</p></>}
            {row.text !== undefined && <><strong>拟保存内容</strong><p className="assistant-text">{row.text}</p></>}
          </article>)}
          <div className="assistant-actions">{(['reject', 'approve'] as const).map(decision =>
            <button className={decision === 'approve' ? 'button primary' : 'button'} key={decision} disabled={busy} onClick={() => void run(async () => {
              const result = await api<{state: string; code?: string}>(token, '/previews/' + preview.id + '/decision', {
                decision, digest: preview.digest, clientRequestId: decisionId
              });
              setPreview(undefined);
              setReference(undefined);
              if (preview.details.kind === 'accept_todo') onCandidateDone?.();
              if (result.state === 'committed') {
                await refresh(token, docOffset);
                setNotice('变更已保存。');
              } else if (result.state === 'rejected') setNotice('已拒绝。');
              else setNotice('需要核对 · ' + result.state + ' · ' + (result.code || ''));
            })}>{decision === 'approve' ? '批准' : '拒绝'}</button>)}</div>
        </section>
      </div>}
    </div>
  );
}
