import {useEffect, useState} from 'react';
import SheetWorkspace from './SheetWorkspace';
import type {SheetTaskRenderer} from './SheetWorkspace';

type Todo = {id: number; title: string; status: 'open' | 'done'; target?: string | null};
type LegacyRun = {id: number; url: string; state: string};
type Request = <T>(route: string, body?: unknown) => Promise<T>;
const recoverable = new Set(['received', 'prepared', 'needs_identity', 'awaiting_approval', 'failed']);

export default function BusinessWorkspace({request, renderTask, execute}: {
  request: Request; renderTask: SheetTaskRenderer; execute: boolean;
}) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [legacy, setLegacy] = useState<LegacyRun[]>([]);
  const [selected, setSelected] = useState<number>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [deleteId, setDeleteId] = useState<number>();

  async function refresh() {
    const [list, old] = await Promise.all([
      request<{items: Todo[]}>('/todos'), request<{items: LegacyRun[]}>('/legacy-runs')
    ]);
    setTodos(list.items); setLegacy(old.items);
    setSelected(id => list.items.some(item => item.id === id && item.status === 'open') ? id : undefined);
  }

  useEffect(() => { void refresh().catch(error => setNotice(error.message)); }, [request]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await work(); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '业务操作失败'); }
    finally { setBusy(false); }
  }

  function todo(id: number, status: string) {
    void act(async () => {
      await request('/todos/' + id + '/decision', {status});
      setDeleteId(undefined);
    });
  }

  return <div className="stack">
    <section className="settings-card">
      <h2>工作区待办</h2>
      <button className="button" disabled={busy} onClick={() => void act(refresh)}>刷新待办</button>
      {notice && <p role="status">{notice}</p>}
      {todos.map(item => <article key={item.id} className="assistant-turn">
        <strong>{item.title}</strong><p>{item.status === 'open' ? '待处理' : '已完成'}</p>
        <div className="assistant-actions">
          {item.status === 'open' && <button className="button" disabled={busy}
            onClick={() => setSelected(item.id)}>为此待办准备填表</button>}
          <button className="button" disabled={busy}
            onClick={() => todo(item.id, item.status === 'open' ? 'done' : 'open')}>
            {item.status === 'open' ? '标为完成' : '重新打开'}
          </button>
          {deleteId === item.id ? <>
            <button className="button" disabled={busy} onClick={() => todo(item.id, 'deleted')}>确认删除待办</button>
            <button className="button" disabled={busy} onClick={() => setDeleteId(undefined)}>取消删除</button>
          </> : <button className="button" disabled={busy} onClick={() => setDeleteId(item.id)}>删除待办</button>}
        </div>
      </article>)}
    </section>
    <section className="settings-card">
      <p>{execute ? '填写执行已启用，须批准当前计划。' : '当前为只读准备模式，填写执行未启用。'}</p>
      {selected && <p>关联待办 #{selected} <button className="button" onClick={() => setSelected(undefined)}>解除关联</button></p>}
    </section>
    <SheetWorkspace key={(selected || 0) + ':' + generation} request={request} renderTask={renderTask} todoId={selected}
      initialTarget={todos.find(item => item.id === selected)?.target || ''} />
    {legacy.length > 0 && <section className="settings-card">
      <h2>早期填表记录</h2>
      {legacy.map(item => <article className="assistant-turn" key={item.id}>
        <p>记录 #{item.id} · {item.state}</p><p className="assistant-text">{item.url}</p>
        {recoverable.has(item.state) && <button className="button" disabled={busy} onClick={() => void act(async () => {
          const created = await request<{id: number}>('/legacy-runs/' + item.id + '/prepare', {});
          setGeneration(old => old + 1);
          setNotice('已提交新任务 #' + created.id + '，旧记录保留。');
        })}>重新准备旧任务</button>}
      </article>)}
    </section>}
  </div>;
}
