import {useCallback, useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {ArrowUp, BookOpen, Globe2, MessageCircle, SlidersHorizontal, Sparkles, X} from 'lucide-react';
import {isTauriApp} from '../secure';
import Research from './Research';
import QQInbox from './QQInbox';
import BusinessWorkspace from './BusinessWorkspace';
import type {SheetTaskRenderer} from './SheetWorkspace';
import type {EffortPresets} from './Research';
import type {Ability} from './QQInbox';

type Model = {id: string; label: string};
type Source = {id: string; name: string; status: string};
type Evidence = {id: string; title: string; locator: string; quote: string; revision: string; url?: string; provider?: string};
type Session = {id: string; state: string; seq: number; turns: {
  id: string; question: string; result?: {status: string; answer?: string; evidence: Evidence[]; abilityError?: string};
}[]};
type Report = {id: string; name: string; digest: string; text: string};
export type WorkspaceView = 'chat' | 'research' | 'qq' | 'business';

const prompts = ['帮我总结一份资料', '从知识库找出相关来源', '帮我梳理一个问题'];

const labels: Record<string, string> = {
  no_evidence: '知识库没有找到相关资料。', local_evidence: '本机检索结果',
  model_unavailable: '所选模型暂不可用。', model_timeout: '模型请求超时，可以重新提问。',
  model_failed: '模型请求失败。', invalid_model_output: '模型返回的格式或引用无效。',
  cloud_grant_required: '请先为相关资料授予云端模型处理许可。',
  source_changed: '资料或授权已变化，请重新提问。', cancelled: '已取消。',
  unauthorized: '请检查知识库访问令牌。', session_expired: '主机会话已释放，请新建会话。',
  report_name_exists: '报告文件名已存在，请换一个名称。',
  preview_changed: '报告或授权已变化，请重新预览。',
  ability_disabled: '未启用公网搜索。', ability_timeout: '公网搜索超时。',
  ability_provider_failed: '搜索服务暂时不可用。', ability_rate_limited: '搜索服务暂时限流。'
};
let browserToken = '';

export default function PythonWorkspace({renderSheetTask, view, onOpenLegacy}: {
  renderSheetTask: SheetTaskRenderer; view: WorkspaceView; onOpenLegacy: () => void;
}) {
  const [token, setToken] = useState(browserToken);
  const [draft, setDraft] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [presets, setPresets] = useState<EffortPresets>();
  const [session, setSession] = useState<Session>();
  const [question, setQuestion] = useState('');
  const [cloud, setCloud] = useState(false);
  const [abilities, setAbilities] = useState<Ability[]>([]);
  const [business, setBusiness] = useState<{enabled: boolean; execute: boolean}>();
  const [webQuery, setWebQuery] = useState('');
  const [reference, setReference] = useState<Evidence>();
  const [report, setReport] = useState<Report>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const connectionInput = useRef<HTMLInputElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const lastTurn = useRef<HTMLDivElement>(null);

  const request = useCallback(async <T,>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const prefix = route.startsWith('/evidence/') ? '/knowledge' : '/interaction';
    const response = await fetch('http://127.0.0.1:9089/api/v1' + prefix + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', redirect: 'error', signal
    });
    const payload = await response.json();
    if (!response.ok) throw Error(typeof payload.detail === 'string' ? payload.detail : 'invalid_input');
    return payload;
  }, [token]);

  async function run(work: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await work(); } catch (error) {
      const code = error instanceof Error ? error.message : 'workbench_unavailable';
      setNotice(labels[code] || code);
    } finally { setBusy(false); }
  }

  useEffect(() => {
    let alive = true;
    if (isTauriApp()) void invoke<string | null>('get_workbench_token').then(saved => {
      if (saved && alive) setToken(saved);
    }).catch(() => { if (alive) setNotice('读取本机访问令牌失败。'); });
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [cap, docs, sessions, available, businessState] = await Promise.all([
      request<{models: Model[]; effortPresets: EffortPresets}>('/capabilities', undefined, signal),
      request<{items: Source[]}>('/documents', undefined, signal),
      request<{items: {id: string}[]}>('/sessions', undefined, signal),
      request<{items: Ability[]}>('/abilities', undefined, signal),
      request<{enabled: boolean; execute: boolean}>('/business', undefined, signal)
    ]);
    const last = sessions.items.at(-1);
    const current = last ? await request<Session>('/sessions/' + last.id, undefined, signal) : undefined;
    if (signal?.aborted) return;
    setModels(cap.models); setPresets(cap.effortPresets); setSources(docs.items);
    setAbilities(available.items);
    setBusiness(businessState);
    setModel(old => cap.models.some(item => item.id === old) ? old : cap.models[0]?.id || '');
    setSession(current);
  }, [request]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch(error => {
      if (!controller.signal.aborted) setNotice(labels[error.message] || '无法连接 Python 工作台，请检查主机服务。');
    });
    return () => controller.abort();
  }, [token, refresh]);

  useEffect(() => {
    if (!token || !session) return;
    const controller = new AbortController();
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void request<Session>('/sessions/' + session.id, undefined, controller.signal).then(current => {
        if (!controller.signal.aborted) {
          setSession(old => old?.id === current.id && old.seq <= current.seq ? current : old);
          setReference(old => old && current.turns.some(turn =>
            turn.result?.evidence.some(item => item.id === old.id && item.revision === old.revision)) ? old : undefined);
        }
      }).catch(error => {
        if (controller.signal.aborted) return;
        if (error.message === 'session_expired') { setSession(undefined); setReference(undefined); }
        setNotice(labels[error.message] || '与主机的连接中断，正在重试。');
      }).finally(() => { pending = false; });
    }, session.state === 'running' ? 700 : 3000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [token, request, session?.id, session?.state]);

  const searchEnabled = abilities.some(item => item.id === 'web.search' && item.state === 'available');
  const qqEnabled = abilities.some(item => item.id === 'qq.listen' && ['running', 'degraded'].includes(item.state));
  const connected = Boolean(token && presets);
  const waiting = session?.state === 'running';
  const turnCount = session?.turns.length || 0;

  useEffect(() => {
    if (view === 'chat' && turnCount) lastTurn.current?.scrollIntoView({block: 'nearest'});
  }, [turnCount, waiting, view]);

  useEffect(() => {
    if (showConnection) connectionInput.current?.focus();
  }, [showConnection]);

  return <div className="stack assistant-page">
    <div className="workspace-toolbar">
      <button className="connection-chip" type="button" aria-expanded={showConnection}
        onClick={() => setShowConnection(open => !open)}>
        <span className={connected ? 'connected' : ''} />
        {connected ? '本机工作台已连接' : '连接本机工作台'}
      </button>
      <button className="workspace-legacy" type="button" onClick={onOpenLegacy}>旧版资料管理与工具</button>
    </div>
    {showConnection && <form className="settings-card connection-panel" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const value = draft.trim();
        const response = await fetch('http://127.0.0.1:9089/api/v1/interaction/capabilities', {
          headers: {Authorization: 'Bearer ' + value}, redirect: 'error', cache: 'no-store'
        });
        if (!response.ok) throw Error(response.status === 401 ? 'unauthorized' : 'workbench_unavailable');
        if (isTauriApp()) await invoke('save_workbench_token', {token: value});
        browserToken = value; setToken(value); setDraft(''); setShowConnection(false);
        if (value === token) await refresh();
      });
    }}>
      <h2>工作台连接</h2>
      <label>本机访问令牌<input ref={connectionInput} type="password" autoComplete="off" value={draft}
        onChange={event => setDraft(event.target.value)} /></label>
      <div className="assistant-actions">
        <button className="button primary" disabled={busy || !draft.trim()}>连接</button>
        {token && <button type="button" className="button" disabled={busy} onClick={() => void run(() => refresh())}>刷新主机</button>}
        {token && <button type="button" className="button" disabled={busy} onClick={() => void run(async () => {
          if (isTauriApp()) await invoke('delete_workbench_token');
          browserToken = ''; setToken(''); setPresets(undefined); setModels([]); setSources([]); setSelected([]);
          setSession(undefined); setReference(undefined); setReport(undefined); setCloud(false);
          setAbilities([]); setBusiness(undefined); setWebQuery('');
        })}>忘记令牌</button>}
      </div>
    </form>}
    {notice && <div className="callout" role="status">{notice}</div>}

    {view === 'chat' ? <section className="chat-panel" aria-label="AI 聊天对话">
      <div className="chat-feed">
        {!turnCount && <div className="chat-welcome">
          <div className="chat-emblem" aria-hidden="true"><Sparkles size={32} strokeWidth={1.7} /></div>
          <span className="chat-eyebrow">课桌助手</span>
          <h2>今天想聊些什么？</h2>
          <p>用你的知识库提问、整理思路，沿着引用查阅原文。</p>
          <div className="chat-prompts" aria-label="试试这些问题">
            {prompts.map(prompt => <button key={prompt} type="button" onClick={() => {
              setQuestion(prompt); questionInput.current?.focus();
            }}><MessageCircle size={15} aria-hidden="true" />{prompt}</button>)}
          </div>
        </div>}
        {turnCount > 0 && <div className="chat-transcript" role="log" aria-label="对话记录">
          {session?.turns.map(turn => <article className="chat-turn" key={turn.id}>
            <div className="chat-user-message"><span className="chat-message-label">你</span>
              <p className="assistant-text">{turn.question}</p></div>
            <div className="chat-reply">
              <span className="chat-reply-icon"><Sparkles size={17} aria-hidden="true" /></span>
              <div className="chat-reply-body">
                <span className="chat-message-label">课桌助手</span>
                <p className="assistant-text">{turn.result ? turn.result.answer || labels[turn.result.status] || turn.result.status : '正在检索或生成…'}</p>
                {turn.result?.abilityError && <p>{labels[turn.result.abilityError] || turn.result.abilityError}</p>}
                {turn.result?.evidence.map(item => item.url ? <a className="button assistant-source" key={item.id}
                  href={item.url} target="_blank" rel="noopener noreferrer">{item.title} · {item.provider}</a>
                  : <button type="button" className="button assistant-source" key={item.id} onClick={() =>
                    void run(async () => setReference(await request<Evidence>('/evidence/' + encodeURIComponent(item.id) + '?revision=' + encodeURIComponent(item.revision))))}>
                    {item.title} · {item.locator}
                  </button>)}
              </div>
            </div>
          </article>)}
        </div>}
        {reference && <aside className="chat-reference" aria-label="引用原文">
          <strong>{reference.title} · {reference.locator}</strong>
          <button type="button" className="icon-button" aria-label="收起引用" onClick={() => setReference(undefined)}><X size={16} /></button>
          <p className="assistant-text">{reference.quote}</p>
        </aside>}
        <div ref={lastTurn} />
      </div>
      <form className="chat-composer" onSubmit={event => {
        event.preventDefault();
        if (!question.trim() || busy || waiting || (cloud && !model)) return;
        if (!connected) { setShowConnection(true); return; }
        void run(async () => {
          const target = session || await request<Session>('/sessions', {});
          setSession(target);
          await request('/sessions/' + target.id + '/turns', {
            question, clientRequestId: crypto.randomUUID(), useModel: cloud, modelId: model, sourceIds: selected,
            webQuery: searchEnabled ? webQuery.trim() || undefined : undefined
          });
          setSession(await request<Session>('/sessions/' + target.id));
          setQuestion(''); setWebQuery('');
        });
      }}>
        <label className="chat-question"><span className="chat-sr-only">问题</span>
          <textarea ref={questionInput} value={question} maxLength={2048} rows={2} placeholder="输入你的问题…"
            onChange={event => setQuestion(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault(); event.currentTarget.form?.requestSubmit();
              }
            }} />
        </label>
        <div className="chat-composer-actions">
          <span className="chat-mode"><BookOpen size={14} aria-hidden="true" />{cloud ? '模型整理' : '本机知识库'}</span>
          {connected && <details className="chat-options">
            <summary><SlidersHorizontal size={15} aria-hidden="true" />问答选项{selected.length > 0 && ' · ' + selected.length}</summary>
            <div className="chat-options-panel">
              <label className="assistant-checkbox"><input type="checkbox" checked={cloud} disabled={!models.length}
                onChange={event => setCloud(event.target.checked)} />使用模型整理已授权资料</label>
              {cloud && <label>模型<select value={model} onChange={event => setModel(event.target.value)}>
                {models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select></label>}
              {searchEnabled && <label><span><Globe2 size={14} aria-hidden="true" /> 本次公网搜索词（可选）</span>
                <input maxLength={200} value={webQuery} onChange={event => setWebQuery(event.target.value)} />
                <small>提交会将此处的搜索词发送给搜索服务。</small>
              </label>}
              <details><summary>指定资料（已选 {selected.length} 份）</summary>
                <div className="assistant-entries">{sources.map(source => <label className="assistant-checkbox" key={source.id}>
                  <input type="checkbox" checked={selected.includes(source.id)}
                    disabled={selected.length >= 16 && !selected.includes(source.id)}
                    onChange={event => setSelected(ids => event.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id))} />
                  {source.name}
                </label>)}</div>
              </details>
              {session && <button type="button" className="button" disabled={busy} onClick={() => void run(async () => {
                await request('/sessions/' + session.id + '/close', {}); setSession(undefined); setReference(undefined);
              })}>关闭对话</button>}
            </div>
          </details>}
          <div className="chat-send">
            {waiting ? <button type="button" className="button" disabled={busy}
              onClick={() => session && void run(async () => setSession(await request<Session>('/sessions/' + session.id + '/cancel', {})))}>取消生成</button>
              : <button className="button primary chat-send-button" aria-label="发送消息" disabled={busy || !question.trim() || (cloud && !model)}>
                <ArrowUp size={16} aria-hidden="true" /><span>发送</span>
              </button>}
          </div>
        </div>
        <p className="chat-keyboard-hint">Enter 发送 · Shift + Enter 换行</p>
      </form>
    </section> : view === 'business' && business?.enabled
      ? <BusinessWorkspace request={request} renderTask={renderSheetTask} execute={business.execute} />
      : view === 'qq' && qqEnabled ? <QQInbox request={request} />
      : view === 'research' && presets ? <Research request={request} models={models} sources={sources} presets={presets}
        pendingPreview={!!report} save={async (id, name, includeProcess) =>
          setReport(await request<Report>('/research/' + id + '/save-preview', {name, includeProcess}))}
        recheckCompleted />
      : <section className="settings-card">
        <h2>{!connected ? '请先连接本机工作台' : '当前主机未启用此能力'}</h2>
        {!connected && <button className="button" type="button" onClick={() => setShowConnection(true)}>设置连接</button>}
      </section>}
    {report && <section className="settings-card">
      <h3>保存预览 · {report.name}</h3><p className="assistant-text">{report.text}</p>
      <div className="assistant-actions">{(['approve', 'reject'] as const).map(decision => <button key={decision}
        className={decision === 'approve' ? 'button primary' : 'button'} disabled={busy}
        onClick={() => void run(async () => {
          await request('/report-previews/' + report.id + '/decision', {decision, digest: report.digest});
          setReport(undefined);
          if (decision === 'approve') {
            const docs = await request<{items: Source[]}>('/documents');
            setSources(docs.items); setNotice('已保存到知识库。');
          }
        })}>{decision === 'approve' ? '批准保存' : '拒绝'}</button>)}</div>
    </section>}
  </div>;
}
