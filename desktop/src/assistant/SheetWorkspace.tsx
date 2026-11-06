import {useEffect, useState} from 'react';
import type {ReactNode} from 'react';
import type {Plan, Task} from '../types';

export type SheetActions = {
  approve: (plan: Plan) => void;
  answer: (answers: {key: string; value: string}[]) => void;
  cancel: () => void;
  reconcile: () => void;
  resume: () => void;
};
export type SheetTaskRenderer = (task: Task, actions: SheetActions, busy: boolean) => ReactNode;

const runningStates = new Set(['created', 'preparing', 'approved', 'executing', 'verifying']);

export default function SheetWorkspace({request, renderTask}: {
  request: <T>(route: string, body?: unknown) => Promise<T>;
  renderTask: SheetTaskRenderer;
}) {
  const [target, setTarget] = useState('');
  const [items, setItems] = useState<Task[]>([]);
  const [task, setTask] = useState<Task>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const path = '/sheet-tasks';

  async function list() {
    setItems((await request<{items: Task[]}>(path)).items);
  }
  async function open(id: number) {
    setTask(await request<Task>(path + '/' + id));
  }
  useEffect(() => { void list().catch(error => setNotice(error.message)); }, [request]);
  useEffect(() => {
    if (!task || !runningStates.has(task.state)) return;
    let mounted = true;
    const timer = window.setInterval(() => {
      void request<Task>(path + '/' + task.id).then(result => {
        if (mounted) setTask(current => current?.id === result.id && current.state_version <= result.state_version ? result : current);
      }).catch(error => { if (mounted) setNotice(error.message); });
    }, 1000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [request, task?.id, task?.state]);

  async function run(work: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await work(); } catch (error) {
      const messages: Record<string, string> = {
        invalid_target: '请提供受支持的腾讯表格链接。',
        execute_disabled: '填写执行开关已关闭，可以查看计划。',
        profile_changed: '个人资料已变化，任务需要重新准备。',
        plan_not_current: '原计划已过期，请刷新并核对新计划。'
      };
      const code = error instanceof Error ? error.message : '操作失败';
      setNotice(messages[code] || code);
      if (task && ['profile_changed', 'plan_not_current'].includes(code)) await open(task.id).catch(() => {});
    } finally { setBusy(false); }
  }
  function action(name: string, body: unknown = {}) {
    if (!task) return;
    void run(async () => { await request(path + '/' + task.id + '/' + name, body); await open(task.id); await list(); });
  }

  return <section className="settings-card">
    <h2>工作区填表</h2>
    <form onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        const created = await request<Task>(path, {target: target.trim(), clientRequestId: crypto.randomUUID()});
        setTarget(''); await open(created.id); await list();
      });
    }}>
      <label>腾讯表格链接<input value={target} maxLength={2048} onChange={event => setTarget(event.target.value)} /></label>
      <button className="button primary" disabled={busy || !target.trim()}>只读准备填表计划</button>
    </form>
    <button className="button" disabled={busy} onClick={() => void run(async () => { await list(); if (task) await open(task.id); })}>刷新填表任务</button>
    {notice && <p role="status">{notice}</p>}
    <div className="assistant-entries">{items.map(item =>
      <button className="button" key={item.id} disabled={busy} onClick={() => void run(() => open(item.id))}>
        任务 #{item.id} · {item.target_ref}
      </button>)}</div>
    {task && renderTask(task, {
      approve: plan => action('approvals', {plan_id: plan.id, plan_version: plan.version, plan_digest: plan.digest,
        client_request_id: crypto.randomUUID()}),
      answer: answers => action('answers', {answers}),
      cancel: () => action('cancel'),
      reconcile: () => action('reconcile'),
      resume: () => action('resume')
    }, busy)}
  </section>;
}
