import {useCallback, useEffect, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
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

export default function PythonWorkspace({renderSheetTask}: {renderSheetTask: SheetTaskRenderer}) {
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
  const [research, setResearch] = useState(false);
  const [abilities, setAbilities] = useState<Ability[]>([]);
  const [showQQ, setShowQQ] = useState(false);
  const [showBusiness, setShowBusiness] = useState(false);
  const [business, setBusiness] = useState<{enabled: boolean; execute: boolean}>();
  const [webQuery, setWebQuery] = useState('');
  const [reference, setReference] = useState<Evidence>();
  const [report, setReport] = useState<Report>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

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

  return <div className="stack assistant-page">
    <form className="settings-card" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const value = draft.trim();
        const response = await fetch('http://127.0.0.1:9089/api/v1/interaction/capabilities', {
          headers: {Authorization: 'Bearer ' + value}, redirect: 'error', cache: 'no-store'
        });
        if (!response.ok) throw Error(response.status === 401 ? 'unauthorized' : 'workbench_unavailable');
        if (isTauriApp()) await invoke('save_workbench_token', {token: value});
        browserToken = value; setToken(value); setDraft('');
      });
    }}>
      <h2>Python 知识工作台</h2>
      <label>本机访问令牌<input type="password" autoComplete="off" value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <div className="assistant-actions">
        <button className="button" disabled={busy || !draft.trim()}>连接</button>
        {token && <button type="button" className="button" disabled={busy} onClick={() => void run(() => refresh())}>刷新主机</button>}
        {token && <button type="button" className="button" disabled={busy} onClick={() => void run(async () => {
          if (isTauriApp()) await invoke('delete_workbench_token');
          browserToken = ''; setToken(''); setPresets(undefined); setModels([]); setSources([]); setSelected([]);
          setSession(undefined); setReference(undefined); setReport(undefined); setCloud(false); setResearch(false);
          setAbilities([]); setShowQQ(false); setShowBusiness(false); setBusiness(undefined); setWebQuery('');
        })}>忘记令牌</button>}
      </div>
    </form>
    {notice && <div className="callout" role="status">{notice}</div>}
    {token && presets && <>
      <div className="assistant-actions">
        <button className="button" onClick={() => { setResearch(false); setShowQQ(false); setShowBusiness(false); }}>普通问答</button>
        <button className="button" onClick={() => { setResearch(true); setShowQQ(false); setShowBusiness(false); }}>Deeper Research</button>
        {qqEnabled && <button className="button" onClick={() => { setShowQQ(true); setShowBusiness(false); }}>QQ 能力收件箱</button>}
        {business?.enabled && <button className="button" onClick={() => setShowBusiness(true)}>待办与填表</button>}
      </div>
      {showBusiness && business?.enabled ? <BusinessWorkspace request={request} renderTask={renderSheetTask} execute={business.execute} />
        : showQQ && qqEnabled ? <QQInbox request={request} /> : research ? <Research request={request} models={models} sources={sources} presets={presets}
        pendingPreview={!!report} save={async (id, name, includeProcess) =>
          setReport(await request<Report>('/research/' + id + '/save-preview', {name, includeProcess}))}
        recheckCompleted /> : <section className="settings-card">
        <h2>普通问答</h2>
        <form onSubmit={event => {
          event.preventDefault();
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
          <label>问题<textarea value={question} maxLength={2048} onChange={event => setQuestion(event.target.value)} /></label>
          {searchEnabled && <label>本次公网搜索词（可选）
            <input maxLength={200} value={webQuery} onChange={event => setWebQuery(event.target.value)} />
            <small>提交会将此处的搜索词发送给搜索服务。</small>
          </label>}
          <label className="assistant-checkbox"><input type="checkbox" checked={cloud} disabled={!models.length}
            onChange={event => setCloud(event.target.checked)} />使用模型整理已授权资料</label>
          {cloud && <label>模型<select value={model} onChange={event => setModel(event.target.value)}>
            {models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>}
          <details><summary>指定资料（已选 {selected.length} 份）</summary>
            <div className="assistant-entries">{sources.map(source => <label className="assistant-checkbox" key={source.id}>
              <input type="checkbox" checked={selected.includes(source.id)}
                disabled={selected.length >= 16 && !selected.includes(source.id)}
                onChange={event => setSelected(ids => event.target.checked ? [...ids, source.id] : ids.filter(id => id !== source.id))} />
              {source.name}
            </label>)}</div>
          </details>
          <div className="assistant-actions">
            <button className="button primary" disabled={busy || !question.trim() || session?.state === 'running' || (cloud && !model)}>提问</button>
            {session?.state === 'running' && <button type="button" className="button" disabled={busy}
              onClick={() => void run(async () => setSession(await request<Session>('/sessions/' + session.id + '/cancel', {})))}>取消生成</button>}
            {session && <button type="button" className="button" disabled={busy} onClick={() => void run(async () => {
              await request('/sessions/' + session.id + '/close', {}); setSession(undefined); setReference(undefined);
            })}>关闭对话</button>}
          </div>
        </form>
        {session?.turns.map(turn => <article key={turn.id} className="assistant-turn">
          <strong>{turn.question}</strong>
          <p className="assistant-text">{turn.result ? turn.result.answer || labels[turn.result.status] || turn.result.status : '正在检索或生成…'}</p>
          {turn.result?.abilityError && <p>{labels[turn.result.abilityError] || turn.result.abilityError}</p>}
          {turn.result?.evidence.map(item => item.url ? <a className="button assistant-source" key={item.id}
            href={item.url} target="_blank" rel="noopener noreferrer">{item.title} · {item.provider}</a>
            : <button className="button assistant-source" key={item.id} onClick={() =>
            void run(async () => setReference(await request<Evidence>('/evidence/' + encodeURIComponent(item.id) + '?revision=' + encodeURIComponent(item.revision))))}>
            {item.title} · {item.locator}
          </button>)}
        </article>)}
        {reference && <div className="assistant-turn"><strong>{reference.title} · {reference.locator}</strong>
          <p className="assistant-text">{reference.quote}</p><button className="button" onClick={() => setReference(undefined)}>收起引用</button></div>}
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
    </>}
  </div>;
}
