import {useCallback, useEffect, useState} from 'react';

export type Ability = {id: string; mode: string; state: string};
type Source = {id: number; name: string; type: string};
type Item = {id: number; title?: string; body: string; origin: string; source_name: string; state?: string};
type SourceList = {items: Source[]; historyAllowed: boolean; ingressAllowed: boolean};

const labels: Record<string, string> = {
  pending: '待确认', accepted: '已确认待办', dismissed: '已忽略',
  qq_history_denied: '当前工作区没有历史读取许可。',
  ability_provider_failed: '无法连接本机 NapCat，请检查登录及接口状态。',
  qq_account_mismatch: 'NapCat 登录账号与当前来源绑定不一致。'
};

export default function QQInbox({request}: {
  request: <T>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
}) {
  const [sources, setSources] = useState<SourceList>();
  const [sourceId, setSourceId] = useState('');
  const [events, setEvents] = useState<Item[]>([]);
  const [candidates, setCandidates] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [current, messages, suggestions] = await Promise.all([
      request<SourceList>('/qq/sources', undefined, signal),
      request<{items: Item[]}>('/qq/events', undefined, signal),
      request<{items: Item[]}>('/qq/candidates', undefined, signal)
    ]);
    if (signal?.aborted) return;
    setSources(current); setEvents(messages.items); setCandidates(suggestions.items);
    setSourceId(old => current.items.some(item => String(item.id) === old) ? old : String(current.items[0]?.id || ''));
  }, [request]);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try { await refresh(controller.signal); }
      catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? labels[error.message] || error.message : '刷新失败'); }
      finally { pending = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [refresh]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await work(); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? labels[error.message] || error.message : 'QQ 操作失败'); }
    finally { setBusy(false); }
  }

  return <section className="settings-card">
    <h2>QQ 能力收件箱</h2>
    <button className="button" disabled={busy} onClick={() => void act(async () => {
      await request('/qq/probe');
      setNotice('已连接到预期的 NapCat 账号。');
    })}>检测 NapCat 连接</button>
    {sources && <p>实时接入{sources.ingressAllowed ? '已授权' : '未授权'} · 历史读取{sources.historyAllowed ? '已授权' : '未授权'}</p>}
    <form onSubmit={event => {
      event.preventDefault();
      void act(async () => {
        const result = await request<{stored: number; duplicates: number; filtered: number}>('/qq/history', {sourceId: Number(sourceId)});
        setNotice('已接收 ' + result.stored + ' 条 · 重复 ' + result.duplicates + ' 条 · 过滤 ' + result.filtered + ' 条');
      });
    }}>
      <label>历史来源<select value={sourceId} onChange={event => setSourceId(event.target.value)}>
        {sources?.items.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
      </select></label>
      <button className="button" disabled={busy || !sourceId || !sources?.historyAllowed}>拉取最近历史</button>
    </form>
    {notice && <p role="status">{notice}</p>}
    <h3>待办候选</h3>
    {candidates.map(item => <article className="assistant-turn" key={item.id}>
      <strong>{item.title}</strong>
      <p className="assistant-text">{item.body}</p>
      <p>{item.source_name} · {item.origin === 'history' ? '历史' : '实时'} · {labels[item.state || '']}</p>
      {item.state === 'pending' && <div className="assistant-actions">
        <button className="button primary" disabled={busy} onClick={() => void act(async () => {
          await request('/qq/candidates/' + item.id + '/decision', {decision: 'accepted'});
        })}>确认待办</button>
        <button className="button" disabled={busy} onClick={() => void act(async () => {
          await request('/qq/candidates/' + item.id + '/decision', {decision: 'dismissed'});
        })}>忽略</button>
      </div>}
    </article>)}
    <details><summary>最近消息（{events.length}）</summary>
      {events.map(item => <article className="assistant-turn" key={item.id}>
        <strong>{item.source_name} · {item.origin === 'history' ? '历史' : '实时'}</strong>
        <p className="assistant-text">{item.body}</p>
      </article>)}
    </details>
  </section>;
}
