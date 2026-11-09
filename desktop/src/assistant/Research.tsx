import {useEffect, useState} from 'react';

type Limits = {tokens: number; calls: number; rounds: number; activeMs: number};
type Preset = 'low' | 'medium' | 'high';
export type EffortPresets = Record<Preset, Limits>;
type Model = {id: string; label: string};
type Source = {id: string; name: string; status: string};
type Agent = {id: string; modelId: string; prompt: string};
type Evidence = {id: string; title: string; locator: string; quote: string; revision?: string};
type Artifact = {id: string; seq: number; round: number; phase: string; agentId: string; modelId: string;
  data: {answer?: string; finding?: string; proposed_revision?: string; reason?: string; preferred?: string; gaps?: string[]; disagreements?: string[]}};
type Snapshot = {
  id: string; question: string; state: string; version: number; seq: number; phase: string | null; reason: string | null;
  sourceCount: number; limited: boolean; summarizer: string; failed: {agentId: string; code: string}[];
  budget: {limits: Limits; tokens: number; reserved: number; calls: number; rounds: number; activeMs: number; estimatedCalls: number; excessTokens: number};
  requirements: {text: string; time: string}[];
  result: null | {answer: string; evidence: Evidence[]; provisional: boolean; gaps: string[]; disagreements: string[]};
};
type Item = Pick<Snapshot, 'id' | 'question' | 'state'>;

const labels: Record<string, string> = {
  low: '低', medium: '中', high: '高', custom: '自定义',
  queued: '等待开始', running: '研究中', paused: '已暂停', completed: '已完成',
  budget_exhausted: '预算用尽', partial: '部分完成', failed: '失败', cancelled: '已取消',
  explore: '独立探索', review: '交叉评审', synthesize: '修订与汇总', assess: '比较结果',
  tokens: 'Token', calls: '模型调用次数', rounds: '讨论轮数', time: '有效运行时长',
  activeMs: '有效运行时长（毫秒）', source_changed: '来源或授权已变化',
  all_agents_failed: '所有参与者失败', no_improvement: '连续评估未改善', no_result: '暂无可交付结果',
  review_unavailable: '缺少独立复核', model_failed: '模型请求失败', model_unavailable: '模型不可用',
  model_timeout: '模型请求超时', context_limit: '资料超过模型上下文限制',
  invalid_model_output: '模型响应无法读取', invalid_research_response: '模型响应格式或引用无效',
  usage_overrun: '实际用量超过预留'
};

function limitFields(value: Limits, change: (next: Limits) => void) {
  return (Object.keys(value) as (keyof Limits)[]).map(key => <label key={key}>{labels[key]}
    <input type="number" min={1} step={1} value={value[key]} onChange={event => change({...value, [key]: Number(event.target.value)})} />
  </label>);
}

export default function Research({request, models, sources, presets, save, pendingPreview, recheckCompleted = false}: {
  request: <T>(route: string, body?: unknown) => Promise<T>;
  models: Model[];
  sources: Source[];
  presets: EffortPresets;
  save: (id: string, name: string, includeProcess: boolean) => Promise<void>;
  pendingPreview: boolean;
  recheckCompleted?: boolean;
}) {
  const [question, setQuestion] = useState('');
  const [criteria, setCriteria] = useState('');
  const [agents, setAgents] = useState<Agent[]>(() => [1, 2].map(index => ({id: 'agent-' + index, modelId: models[0]?.id || '', prompt: ''})));
  const [preset, setPreset] = useState<Preset | 'custom'>('low');
  const [custom, setCustom] = useState<Limits>({...presets.low});
  const [selected, setSelected] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [task, setTask] = useState<Snapshot>();
  const [process, setProcess] = useState<Artifact[]>([]);
  const [next, setNext] = useState(0);
  const [requirement, setRequirement] = useState('');
  const [increase, setIncrease] = useState<Limits>();
  const [filename, setFilename] = useState('研究报告.md');
  const [includeProcess, setIncludeProcess] = useState(false);
  const [reference, setReference] = useState<Evidence>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function open(id: string) {
    setTask(await request<Snapshot>('/research/' + id));
    setProcess([]); setNext(0); setReference(undefined); setIncrease(undefined);
  }
  async function refreshList() {
    const data = await request<{items: Item[]}>('/research');
    setItems(data.items);
    return data.items;
  }

  useEffect(() => {
    let mounted = true;
    void request<{items: Item[]}>('/research').then(async data => {
      if (!mounted) return;
      setItems(data.items);
      const latest = data.items.find(item => item.state === 'running') || data.items.at(-1);
      if (latest) {
        const current = await request<Snapshot>('/research/' + latest.id);
        if (mounted) setTask(current);
      }
    }).catch(error => { if (mounted) setNotice(error.message); });
    return () => { mounted = false; };
  }, [request]);

  useEffect(() => {
    if (!task || (!recheckCompleted && !['queued', 'running', 'paused'].includes(task.state))) return;
    let mounted = true;
    let loading = false;
    const timer = window.setInterval(() => {
      if (loading) return;
      loading = true;
      void request<Snapshot>('/research/' + task.id).then(current => {
        if (mounted) {
          setTask(old => old?.id === current.id && old.seq <= current.seq ? current : old);
          if (!current.sourceCount) { setReference(undefined); setProcess([]); setNext(0); }
        }
      }).catch(error => {
        if (!mounted) return;
        if (error.message === 'session_expired') {
          setTask(undefined); setProcess([]); setReference(undefined);
          setNotice('后台研究会话已释放。');
        } else setNotice(error.message);
      }).finally(() => { loading = false; });
    }, ['queued', 'running'].includes(task.state) ? 700 : 3000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [task?.id, task?.state, request, recheckCompleted]);

  async function run(work: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await work(); } catch (error) {
      const code = error instanceof Error ? error.message : 'research_failed';
      const messages: Record<string, string> = {no_evidence: '没有找到可用于研究的资料。', cloud_grant_required: '请先为所需资料授予模型处理权限。',
        busy: '已有研究在运行或正在结束请求，稍后重试。', stale_version: '任务状态已变化，已尝试刷新。',
        invalid_budget: '请填写有效的预算上限。', source_changed: '资料或授权已变化，请核对后继续。'};
      setNotice(messages[code] || labels[code] || code);
      if (code === 'session_expired') {
        setTask(undefined); setProcess([]); setReference(undefined);
        setNotice('后台研究会话已释放。');
      }
      if (task && code === 'stale_version') {
        try { setTask(await request<Snapshot>('/research/' + task.id)); } catch { /* 保留状态冲突提示 */ }
      }
    } finally { setBusy(false); }
  }

  function control(action: string, input?: unknown) {
    if (!task) return;
    void run(async () => {
      const state = await request<Snapshot>('/research/' + task.id + '/control', {
        action, input, clientRequestId: crypto.randomUUID(), expectedVersion: task.version
      });
      setTask(state);
      if (action === 'add_requirement') setRequirement('');
      if (action === 'increase_budget') setIncrease(undefined);
    });
  }

  const limits = preset === 'custom' ? custom : presets[preset];
  const canEdit = task && ['running', 'paused', 'budget_exhausted'].includes(task.state);
  return <div className="stack">
    <section className="settings-card">
      <h2>Deeper Research</h2>
      <p>研究使用获授权的知识库片段。关闭窗口后，可回到这里查看后台进度。</p>
      <form onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const created = await request<Snapshot>('/research', {clientRequestId: crypto.randomUUID(), question,
            completionCriteria: criteria.trim() || undefined, agents, sourceIds: selected,
            effort: {preset, limits: preset === 'custom' ? custom : undefined}});
          await refreshList();
          await open(created.id);
        });
      }}>
        <label>研究问题<textarea value={question} maxLength={2048} onChange={event => setQuestion(event.target.value)} /></label>
        <label>完成标准（可选）<input value={criteria} maxLength={1000} onChange={event => setCriteria(event.target.value)} /></label>
        <label>Agent 数量<select value={agents.length} onChange={event => {
          const count = Number(event.target.value);
          setAgents(current => Array.from({length: count}, (_, i) => current[i] || {id: 'agent-' + (i + 1), modelId: models[0]?.id || '', prompt: ''}));
        }}><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option></select></label>
        {agents.map((agent, index) => <fieldset key={agent.id}>
          <legend>Agent {index + 1}</legend>
          <label>模型 {index + 1}<select value={agent.modelId} onChange={event => setAgents(values =>
            values.map((item, i) => i === index ? {...item, modelId: event.target.value} : item))}>
            {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
          <label>提示词 {index + 1}（可选）<textarea maxLength={2000} value={agent.prompt} onChange={event => setAgents(values =>
            values.map((item, i) => i === index ? {...item, prompt: event.target.value} : item))} /></label>
        </fieldset>)}
        <label>effort<select value={preset} onChange={event => setPreset(event.target.value as typeof preset)}>
          {['low','medium','high','custom'].map(key => <option key={key} value={key}>{labels[key]}</option>)}
        </select></label>
        <p>{limits.tokens} token · {limits.calls} 次调用 · {limits.rounds} 轮 · {Math.round(limits.activeMs / 1000)} 秒有效运行</p>
        {preset === 'custom' && limitFields(custom, setCustom)}
        <details><summary>指定资料（可选，已选择 {selected.length} 份）</summary>
          <div className="assistant-entries">{sources.filter(source => source.status === 'active').map(source =>
            <label className="assistant-checkbox" key={source.id}><input type="checkbox" checked={selected.includes(source.id)}
              disabled={!selected.includes(source.id) && selected.length >= 16}
              onChange={event => setSelected(items => event.target.checked ? [...items, source.id] : items.filter(id => id !== source.id))} />
              {source.name}</label>)}</div>
        </details>
        <button className="button primary" disabled={busy || !question.trim() || agents.some(agent => !agent.modelId)}>开始新研究</button>
      </form>
    </section>
    {!!notice && <div className="callout" role="status">{notice}</div>}
    <section className="settings-card">
      <h2>研究进度</h2>
      <button className="button" disabled={busy} onClick={() => void run(async () => { await refreshList(); if (task) setTask(await request<Snapshot>('/research/' + task.id)); })}>刷新研究</button>
      {items.map(item => <button className="button" key={item.id} disabled={busy} onClick={() => void run(() => open(item.id))}>{item.question}</button>)}
      {task && <>
        <h3>{task.question}</h3>
        <p>{labels[task.state]}{task.phase ? ' · ' + labels[task.phase] : ''}{task.reason ? ' · ' + (labels[task.reason] || task.reason) : ''}</p>
        <p>汇总者 {task.summarizer} · {task.sourceCount} 段已授权证据</p>
        {task.limited && <p>本次研究覆盖可用授权片段。</p>}
        <p>Token {task.budget.tokens} / {task.budget.limits.tokens}（预留 {task.budget.reserved}；估算 {task.budget.estimatedCalls} 次）
          · 调用 {task.budget.calls} / {task.budget.limits.calls} · 轮次 {task.budget.rounds} / {task.budget.limits.rounds}
          · 用时 {Math.floor(task.budget.activeMs / 1000)} 秒</p>
        {!!task.budget.excessTokens && <p>供应商回执超出预留 {task.budget.excessTokens} token。</p>}
        {task.failed.map(agent => <p key={agent.agentId}>{agent.agentId} · {labels[agent.code] || agent.code}</p>)}
        {task.requirements.map((entry, i) => <p key={i}>补充要求 · {entry.text}</p>)}
        <div className="assistant-actions">
          {task.state === 'running' && <button className="button" disabled={busy} onClick={() => control('pause')}>暂停研究</button>}
          {task.state === 'paused' && <button className="button" disabled={busy} onClick={() => control('resume')}>继续研究</button>}
          {canEdit && <button className="button" disabled={busy} onClick={() => control('cancel')}>取消研究</button>}
          {!canEdit && <button className="button" disabled={busy} onClick={() => void run(async () => {
            await request('/research/' + task.id + '/close', {});
            setTask(undefined); setProcess([]); setReference(undefined); await refreshList();
          })}>关闭并释放内存</button>}
        </div>
        {task.state === 'budget_exhausted' && <div className="assistant-turn">
          {!increase && <button className="button" disabled={busy} onClick={() => setIncrease({...task.budget.limits})}>增加预算</button>}
          {increase && <>{limitFields(increase, setIncrease)}
            <button className="button" disabled={busy} onClick={() => control('increase_budget', {limits: increase})}>确认预算并继续</button></>}
        </div>}
        {canEdit && <form onSubmit={event => {event.preventDefault(); control('add_requirement', {requirement});}}>
          <label>补充当前问题<input value={requirement} maxLength={1000} onChange={event => setRequirement(event.target.value)} /></label>
          <button className="button" disabled={busy || !requirement.trim()}>提交补充要求</button>
        </form>}
        {task.result && <article className="assistant-turn">
          <h3>{task.result.provisional ? '当前初步结果' : '当前较优报告'}</h3>
          <p className="assistant-text">{task.result.answer}</p>
          {task.result.gaps.map((gap, i) => <p key={i}>待解决 · {gap}</p>)}
          {task.result.disagreements.map((item, i) => <p key={i}>分歧 · {item}</p>)}
          {task.result.evidence.map(item => <button key={item.id} className="button assistant-source" onClick={() =>
            void run(async () => setReference(await request<Evidence>('/evidence/' + item.id +
              (recheckCompleted && item.revision ? '?revision=' + encodeURIComponent(item.revision) : ''))))}>{item.title} · {item.locator}</button>)}
          {reference && <p className="assistant-text">{reference.quote}</p>}
          <form onSubmit={event => {event.preventDefault(); void run(() => save(task.id, filename, includeProcess));}}>
            <label>报告文件名<input value={filename} onChange={event => setFilename(event.target.value)} /></label>
            <label className="assistant-checkbox"><input type="checkbox" checked={includeProcess} onChange={event => setIncludeProcess(event.target.checked)} />一并保存研究过程</label>
            <button className="button" disabled={busy || pendingPreview || !filename.trim()}>预览保存报告</button>
          </form>
        </article>}
        <button className="button" disabled={busy} onClick={() => void run(async () => {
          const page = await request<{items: Artifact[]; next: number}>('/research/' + task.id + '/artifacts');
          setProcess(page.items); setNext(page.next);
        })}>查看研究过程</button>
        {task.sourceCount > 0 && process.map(item => <article key={item.id} className="assistant-turn">
          <strong>第 {item.round} 轮 · {item.agentId} · {labels[item.phase]}</strong>
          <p className="assistant-text">{item.data.answer || item.data.finding || item.data.reason}</p>
          {item.data.proposed_revision && <p>修订建议 · {item.data.proposed_revision}</p>}
          {item.data.preferred && <p>比较 · {({new: '采用新版本', previous: '保留原版本', tie: '无法区分优劣'} as Record<string, string>)[item.data.preferred]}</p>}
        </article>)}
        {!!next && <button className="button" disabled={busy} onClick={() => void run(async () => {
          const page = await request<{items: Artifact[]; next: number}>('/research/' + task.id + '/artifacts?after=' + next);
          setProcess(items => [...items, ...page.items]); setNext(page.next);
        })}>读取后续过程</button>}
      </>}
    </section>
  </div>;
}
