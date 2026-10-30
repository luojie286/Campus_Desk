import {useCallback, useEffect, useMemo, useState} from 'react';
import type {FormEvent} from 'react';
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileCheck2,
  FileText,
  Inbox,
  Link2,
  ListTodo,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  X
} from 'lucide-react';
import * as api from './api';
import type {Message, Plan, SourceRow, Suggestion, Task, Todo, View} from './types';

const REFRESH_MS = 5000;

const FIELD_LABELS: Record<string, string> = {
  name: '姓名',
  student_id: '学号',
  sex: '性别',
  age: '年龄',
  major: '专业'
};

const STATE_LABELS: Record<string, string> = {
  created: '待准备',
  preparing: '准备中',
  awaiting_input: '待补充',
  awaiting_approval: '待审批',
  approved: '已批准',
  executing: '执行中',
  verifying: '回读中',
  completed: '已完成',
  outcome_unknown: '结果未知',
  failed_retryable: '可重试',
  failed_terminal: '失败',
  cancelled: '已取消',
  paused_login_required: '需重新登录'
};

const CATEGORY_LABELS: Record<string, string> = {
  form: '表单',
  action: '行动',
  reminder: '提醒',
  file: '附件',
  chat: '聊天',
  unknown: '未分类'
};

const ERROR_LABELS: Record<string, string> = {
  execute_disabled: '写入开关未开启，请先在服务配置中开启 execute。',
  document_busy: '这份文档正在执行另一个操作，请稍后再刷新。',
  task_not_found: '任务不存在或不属于当前账号。',
  plan_not_current: '计划已经更新或失效，请刷新后重新审批。',
  task_account_mismatch: '这个任务属于另一个账号，当前连接无权操作。',
  answers_required: '请先填写需要补充的信息。',
  invalid_answer: '提交的信息不完整或包含未知字段。',
  suggestion_already_decided: '这条候选已经处理过了，请刷新。',
  token_missing: '还没有配置访问令牌。'
};

function errorText(error: unknown) {
  if (error instanceof api.ApiError) {
    if (error.status === 401) return '访问令牌无效或缺失，请在设置中重新填写。';
    if (error.code.startsWith('invalid_transition_')) return '任务状态已经变化，请刷新后再操作。';
    return ERROR_LABELS[error.code] || error.code;
  }
  return error instanceof Error ? error.message : '操作失败';
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function fieldLabel(key: string) {
  return FIELD_LABELS[key] || key;
}

function columnName(index: number) {
  let value = index;
  let result = '';
  while (value > 0) {
    const rest = (value - 1) % 26;
    result = String.fromCharCode(65 + rest) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function cellAddress(row: number, col: number) {
  return `${columnName(col)}${row}`;
}

function stateLabel(state: string) {
  return STATE_LABELS[state] || state;
}

function sourceLabel(source: SourceRow) {
  return source.conversation_type === 'group' ? `群 ${source.conversation_id}` : `私聊 ${source.conversation_id}`;
}

function taskIsActive(task: Task) {
  return ['awaiting_input', 'awaiting_approval', 'approved', 'executing', 'verifying', 'outcome_unknown'].includes(task.state);
}

function toneFor(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash % 5;
}

function App() {
  const [view, setView] = useState<View>('inbox');
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [detailMessage, setDetailMessage] = useState<Message | null>(null);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [search, setSearch] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [credentials, setCredentials] = useState(api.readCredentials());
  const [baseDraft, setBaseDraft] = useState(credentials.base);
  const [tokenDraft, setTokenDraft] = useState(credentials.token);
  const [health, setHealth] = useState<'unknown' | 'ok' | 'down'>('unknown');

  const hasToken = Boolean(credentials.token);

  const refresh = useCallback(async () => {
    if (!api.readCredentials().token) return;
    try {
      const [sourceResult, messageResult, suggestionResult, todoResult, taskResult] = await Promise.all([
        api.loadSources(),
        api.loadMessages(),
        api.loadSuggestions(),
        api.loadTodos(),
        api.loadTasks()
      ]);
      setSources(sourceResult.items);
      setMessages(messageResult.items);
      setSuggestions(suggestionResult.items);
      setTodos(todoResult.items);
      setTasks(taskResult.items);
      setLastUpdated(new Date());
      setHealth('ok');
      setError('');
    } catch (caught) {
      setHealth('down');
      setError(errorText(caught));
    }
  }, []);

  useEffect(() => {
    api.initializeCredentials().then(next => {
      setCredentials(next);
      setBaseDraft(next.base);
      setTokenDraft(next.token);
    }).catch(caught => setError(errorText(caught)));
  }, []);

  useEffect(() => {
    refresh();
    if (!hasToken) return;
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasToken, refresh]);

  useEffect(() => {
    if (!selectedMessageId) {
      setDetailMessage(null);
      return;
    }
    api.loadMessage(selectedMessageId).then(setDetailMessage).catch(caught => setError(errorText(caught)));
  }, [selectedMessageId]);

  useEffect(() => {
    if (!selectedTaskId) {
      setDetailTask(null);
      return;
    }
    api.loadTask(selectedTaskId).then(setDetailTask).catch(caught => setError(errorText(caught)));
  }, [selectedTaskId]);

  useEffect(() => {
    if (!detailMessage && !detailTask) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDetail();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  });

  const suggestionByMessage = useMemo(() => {
    const map = new Map<number, Suggestion>();
    for (const suggestion of suggestions) {
      if (!map.has(suggestion.message_id)) map.set(suggestion.message_id, suggestion);
    }
    return map;
  }, [suggestions]);

  const taskByLink = useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) map.set(task.target_ref, task);
    return map;
  }, [tasks]);

  const activeTasks = tasks.filter(taskIsActive);
  const unreadCount = sources.reduce((sum, source) => sum + source.unread, 0);
  const selectedSource = sources.find(source => source.conversation_id === selectedConversation) || null;

  const visibleMessages = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return messages.filter(message => {
      if (selectedConversation && message.conversation.id !== selectedConversation) return false;
      if (onlyUnread && message.read) return false;
      if (!needle) return true;
      const haystack = [
        message.text,
        message.sender.id,
        message.conversation.id,
        ...message.links,
        ...message.files.map(file => file.file_name || '')
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [messages, onlyUnread, search, selectedConversation]);

  const visibleTodos = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return todos.filter(todo => !needle || todo.title.toLowerCase().includes(needle));
  }, [search, todos]);

  const visibleTasks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter(task => !needle || `${task.id} ${task.target_ref} ${stateLabel(task.state)}`.toLowerCase().includes(needle));
  }, [search, tasks]);

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (success) setNotice(success);
      await refresh();
      if (selectedMessageId) setDetailMessage(await api.loadMessage(selectedMessageId));
      if (selectedTaskId) setDetailTask(await api.loadTask(selectedTaskId));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  function openTask(taskId: number) {
    setSelectedTaskId(taskId);
    setSelectedMessageId(null);
    setView('approvals');
  }

  function openMessage(messageId: number) {
    setSelectedMessageId(messageId);
    setSelectedTaskId(null);
  }

  function closeDetail() {
    setSelectedMessageId(null);
    setSelectedTaskId(null);
  }

  async function saveLogin(event: FormEvent) {
    event.preventDefault();
    try {
      await api.saveCredentials(baseDraft, tokenDraft);
      const next = api.readCredentials();
      setCredentials(next);
      setError('');
      setNotice('连接设置已保存。');
      refresh();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function testHealth() {
    setBusy(true);
    setError('');
    try {
      const result = await api.checkHealth();
      setHealth(result.running ? 'ok' : 'down');
      setNotice(result.running ? '本机服务在线。' : '服务未运行。');
    } catch (caught) {
      setHealth('down');
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function forgetToken() {
    try {
      await api.clearToken();
      const next = api.readCredentials();
      setCredentials(next);
      setTokenDraft('');
      setHealth('unknown');
      setNotice('访问令牌已清除。');
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  const viewMeta = {
    inbox: {
      title: selectedSource ? sourceLabel(selectedSource) : '消息中心',
      subtitle: selectedSource ? selectedSource.last_text || '这个来源还没有正文' : '查看指定来源的群消息、文件和待办候选',
      icon: Inbox
    },
    todos: {title: '待办清单', subtitle: '保留的候选会进入这里，但不会自动执行', icon: ListTodo},
    approvals: {title: '审批请求', subtitle: '文档填写任务在批准后才会写入', icon: FileCheck2},
    settings: {title: '连接设置', subtitle: '连接本机后台并管理访问令牌', icon: Settings}
  }[view];
  const HeaderIcon = viewMeta.icon;
  const placeholder = view === 'inbox' ? '搜索消息、发送者或文件名' : view === 'todos' ? '搜索待办' : view === 'approvals' ? '搜索任务或文档链接' : '搜索当前视图';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-logo">课</div>
          <div className="brand-copy">
            <strong>课桌</strong>
            <span>消息与审批</span>
          </div>
          <button className="icon-button subtle" onClick={() => setView('settings')} aria-label="打开设置">
            <Settings size={17} />
          </button>
        </div>

        <div className="sidebar-search">
          <Search size={15} />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索消息或文件" />
        </div>

        <div className="sidebar-actions">
          <button className="new-button" onClick={() => setView('settings')}>
            <Plus size={15} />
            <span>连接来源</span>
          </button>
          <button className="icon-button subtle" onClick={() => refresh()} disabled={busy} aria-label="刷新">
            <RefreshCw size={16} className={busy ? 'spin' : ''} />
          </button>
        </div>

        <div className="sidebar-section">
          <div className="section-label">来源</div>
          <button
            className={`source-item ${selectedConversation === null ? 'is-active' : ''}`}
            onClick={() => { setSelectedConversation(null); setView('inbox'); }}
          >
            <span className="avatar all"><Inbox size={15} /></span>
            <span className="source-copy">
              <strong>全部消息</strong>
              <span>所有已绑定来源</span>
            </span>
            <span className="source-count">{messages.length}</span>
          </button>
          {sources.map(source => (
            <button
              key={`${source.conversation_type}-${source.conversation_id}`}
              className={`source-item ${selectedConversation === source.conversation_id ? 'is-active' : ''}`}
              onClick={() => { setSelectedConversation(source.conversation_id); setView('inbox'); }}
            >
              <span className={`avatar tone-${toneFor(source.conversation_id)}`}>{source.conversation_type === 'group' ? '群' : '私'}</span>
              <span className="source-copy">
                <strong>{sourceLabel(source)}</strong>
                <span>{source.last_text || '暂无正文'}</span>
              </span>
              <span className={`source-count ${source.unread ? 'has-unread' : ''}`}>{source.unread || source.total}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-section workbench-section">
          <div className="section-label">工作台</div>
          <button className={`nav-item ${view === 'inbox' ? 'is-active' : ''}`} onClick={() => setView('inbox')}>
            <Inbox size={16} />
            <span>消息中心</span>
            {unreadCount > 0 && <span className="nav-count">{unreadCount}</span>}
          </button>
          <button className={`nav-item ${view === 'todos' ? 'is-active' : ''}`} onClick={() => setView('todos')}>
            <ListTodo size={16} />
            <span>待办清单</span>
            {todos.length > 0 && <span className="nav-count">{todos.length}</span>}
          </button>
          <button className={`nav-item ${view === 'approvals' ? 'is-active' : ''}`} onClick={() => setView('approvals')}>
            <FileCheck2 size={16} />
            <span>审批请求</span>
            {activeTasks.length > 0 && <span className="nav-count">{activeTasks.length}</span>}
          </button>
        </div>

        <div className="sidebar-footer">
          <div className="status-line">
            <span className={`status-dot ${health === 'ok' ? 'is-ok' : health === 'down' ? 'is-down' : ''}`} />
            <span>{health === 'ok' ? '本机后台在线' : health === 'down' ? '后台不可用' : '尚未连接'}</span>
          </div>
          <button className={`profile-card ${view === 'settings' ? 'is-active' : ''}`} onClick={() => setView('settings')}>
            <span className="avatar profile-avatar">本</span>
            <span className="profile-copy">
              <strong>本机后台</strong>
              <span>连接与令牌</span>
            </span>
            <Settings size={15} />
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="main-header">
          <div className="header-title">
            <span className="header-icon"><HeaderIcon size={18} /></span>
            <div>
              <h1>{viewMeta.title}</h1>
              <p>{viewMeta.subtitle}</p>
            </div>
          </div>
          <div className="header-actions">
            {view === 'inbox' && (
              <button className={`filter-pill ${onlyUnread ? 'is-active' : ''}`} onClick={() => setOnlyUnread(value => !value)}>
                未读 <span>{unreadCount}</span>
              </button>
            )}
            <button className="icon-button" onClick={() => refresh()} disabled={busy} aria-label="刷新">
              <RefreshCw size={17} className={busy ? 'spin' : ''} />
            </button>
          </div>
        </header>

        <div className="main-scroll">
          <div className="content-column">
            {!hasToken && (
              <div className="callout callout-warm">
                <ShieldCheck size={18} />
                <div><strong>先连接本机服务</strong><p>在设置里填入服务地址和访问令牌，令牌只会保存在本机。</p></div>
                <button className="button primary" onClick={() => setView('settings')}>去设置</button>
              </div>
            )}
            {error && <div className="callout callout-error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
            {notice && <div className="callout callout-info"><CheckCircle2 size={17} /><span>{notice}</span></div>}

            {view === 'inbox' && (
              <div className="stream">
                {!visibleMessages.length && (
                  <EmptyState icon={<Inbox size={22} />} title="这里还没有消息" body="绑定来源后，指定 QQ 用户或群的消息会出现在这里。" />
                )}
                {visibleMessages.map(message => (
                  <MessageCard
                    key={message.id}
                    message={message}
                    suggestion={suggestionByMessage.get(message.id)}
                    taskByLink={taskByLink}
                    busy={busy}
                    onSelectMessage={openMessage}
                    onOpenTask={openTask}
                    onAccept={id => run(() => api.acceptSuggestion(id), '已保留为待办。')}
                    onDismiss={id => run(() => api.dismissSuggestion(id), '已忽略这条候选。')}
                  />
                ))}
              </div>
            )}

            {view === 'todos' && (
              <div className="stack">
                {!visibleTodos.length && <EmptyState icon={<ListTodo size={22} />} title="还没有保留的待办" body="在消息中心把候选保留下来，它们会出现在这里。" />}
                {visibleTodos.map(todo => (
                  <article className="todo-card" key={todo.id}>
                    <span className="todo-check"><CheckCircle2 size={19} /></span>
                    <div className="todo-copy">
                      <h2>{todo.title}</h2>
                      <p>创建于 {formatDate(todo.created_at)} · {todo.status === 'open' ? '待处理' : todo.status}</p>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {view === 'approvals' && (
              <div className="stack">
                {!visibleTasks.length && <EmptyState icon={<FileCheck2 size={22} />} title="还没有审批请求" body="群里出现腾讯文档链接后，这里会出现填写计划。" />}
                {visibleTasks.map(task => (
                  <button className="task-card" key={task.id} onClick={() => openTask(task.id)}>
                    <div className="task-card-top">
                      <span className={`status-pill state-${task.state}`}>{stateLabel(task.state)}</span>
                      <span className="task-number">#{task.id}</span>
                    </div>
                    <h2>文档填写任务</h2>
                    <p className="task-link">{task.target_ref}</p>
                    <div className="task-card-bottom">
                      <span>更新于 {formatDate(task.updated_at)}</span>
                      <span>版本 {task.state_version}</span>
                      <ChevronRight size={16} />
                    </div>
                  </button>
                ))}
              </div>
            )}

            {view === 'settings' && (
              <SettingsView
                base={baseDraft}
                token={tokenDraft}
                health={health}
                busy={busy}
                onBaseChange={setBaseDraft}
                onTokenChange={setTokenDraft}
                onSave={saveLogin}
                onTest={testHealth}
                onForget={forgetToken}
              />
            )}
          </div>
        </div>

        {view !== 'settings' && (
          <div className="composer-area">
            <div className="composer">
              <button className="composer-button" onClick={() => setView('settings')} aria-label="连接设置"><Plus size={17} /></button>
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder={`${placeholder}…`} />
              <button className="composer-send" onClick={() => refresh()} disabled={busy} aria-label="刷新">
                {view === 'inbox' ? <Send size={16} /> : <RefreshCw size={16} className={busy ? 'spin' : ''} />}
              </button>
            </div>
            <div className="composer-hint">
              <span>{lastUpdated ? `更新于 ${formatDate(lastUpdated.toISOString())}` : '等待连接'}</span>
              <span>搜索只影响当前视图</span>
            </div>
          </div>
        )}
      </main>

      {(detailTask || detailMessage) && (
        <div className="modal-layer" role="dialog" aria-modal="true" onClick={closeDetail}>
          <div className="modal" onClick={event => event.stopPropagation()}>
            <button className="modal-close" onClick={closeDetail} aria-label="关闭详情"><X size={18} /></button>
            {detailTask ? (
              <TaskDetail
                task={detailTask}
                busy={busy}
                onApprove={plan => run(() => api.approveTask(detailTask, plan), '审批已提交，正在写入并回读。')}
                onCancel={() => run(() => api.cancelTask(detailTask.id), '任务已取消。')}
                onAnswer={answers => run(() => api.answerTask(detailTask.id, answers), '补充信息已保存，正在重新生成计划。')}
              />
            ) : detailMessage ? (
              <MessageDetail
                message={detailMessage}
                taskByLink={taskByLink}
                busy={busy}
                onOpenTask={openTask}
                onAccept={id => run(() => api.acceptSuggestion(id), '已保留为待办。')}
                onDismiss={id => run(() => api.dismissSuggestion(id), '已忽略这条候选。')}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function MessageCard({
  message,
  suggestion,
  taskByLink,
  busy,
  onSelectMessage,
  onOpenTask,
  onAccept,
  onDismiss
}: {
  message: Message;
  suggestion?: Suggestion;
  taskByLink: Map<string, Task>;
  busy: boolean;
  onSelectMessage: (id: number) => void;
  onOpenTask: (id: number) => void;
  onAccept: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  return (
    <article className={`message-card ${message.read ? '' : 'is-unread'}`}>
      <span className={`avatar message-avatar tone-${toneFor(message.sender.id)}`}>{message.sender.id.slice(-2)}</span>
      <div className="message-body">
        <div className="message-head">
          <strong>成员 {message.sender.id}</strong>
          <span>{message.conversation.type === 'group' ? `群 ${message.conversation.id}` : '私聊'}</span>
          <span className="time">{formatDate(message.received_at)}</span>
          {!message.read && <span className="unread-dot" />}
        </div>
        <p className={`message-copy ${message.text ? '' : 'muted'}`}>{message.text || '（无正文）'}</p>

        {!!message.files.length && (
          <div className="attachment-list">
            {message.files.map(file => (
              <div className={`attachment-card ${file.text_state === 'extracted' ? 'is-ready' : ''}`} key={file.id}>
                <span className="file-icon"><FileText size={16} /></span>
                <div>
                  <strong>{file.file_name || '未命名附件'}</strong>
                  <span>{file.size_bytes ? `${Math.round(file.size_bytes / 1024)} KB` : '大小未知'} · {file.text_state === 'extracted' ? '文字已提取' : file.text_state === 'empty' ? '没有可提取文字' : '处理中'}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {!!message.links.length && (
          <div className="link-list">
            {message.links.map(link => {
              const task = taskByLink.get(link);
              return (
                <div className="link-card" key={link}>
                  <span className="link-icon"><Link2 size={15} /></span>
                  <span className="link-copy">{link.replace('https://docs.qq.com/sheet/', '腾讯表格 · ')}</span>
                  {task ? (
                    <button className="text-action" onClick={() => onOpenTask(task.id)}>查看审批 <ChevronRight size={14} /></button>
                  ) : <span className="muted small">等待任务生成</span>}
                </div>
              );
            })}
          </div>
        )}

        {suggestion && (
          <div className="ai-card">
            <div className="ai-head">
              <span className="ai-badge"><Sparkles size={13} /> 待办候选</span>
              <span className="ai-confidence">{Math.round((suggestion.confidence || 0) * 100)}%</span>
            </div>
            <h3>{suggestion.title}</h3>
            <p>{suggestion.summary || suggestion.rationale || '模型认为这条消息可能需要行动。'}</p>
            {(suggestion.source_count || 1) > 1 && <div className="ai-sources-summary">已合并 {suggestion.source_count} 条来源消息</div>}
            <div className="ai-actions">
              <button className="button primary small" disabled={busy} onClick={() => onAccept(suggestion.id)}>保留为待办</button>
              <button className="button ghost small" disabled={busy} onClick={() => onDismiss(suggestion.id)}>忽略</button>
              <button className="text-action" onClick={() => onSelectMessage(message.id)}>详情</button>
              <span className="category">{CATEGORY_LABELS[suggestion.category] || suggestion.category}</span>
            </div>
          </div>
        )}

        <div className="message-foot">
          <button className="text-action" onClick={() => onSelectMessage(message.id)}>查看详情</button>
        </div>
      </div>
    </article>
  );
}

function MessageDetail({
  message,
  taskByLink,
  busy,
  onOpenTask,
  onAccept,
  onDismiss
}: {
  message: Message;
  taskByLink: Map<string, Task>;
  busy: boolean;
  onOpenTask: (id: number) => void;
  onAccept: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <span className="eyebrow">消息详情</span>
          <h2>成员 {message.sender.id}</h2>
          <p>{message.conversation.type === 'group' ? `群 ${message.conversation.id}` : '私聊'} · {formatDate(message.received_at)}</p>
        </div>
        <span className={`status-pill ${message.read ? '' : 'state-awaiting_approval'}`}>{message.read ? '已读' : '未读'}</span>
      </div>

      <section className="detail-section">
        <h3>原始消息</h3>
        <p className="detail-copy">{message.text || '（无正文）'}</p>
      </section>

      {!!message.files.length && (
        <section className="detail-section">
          <h3>附件</h3>
          {message.files.map(file => (
            <div className="detail-file" key={file.id}>
              <span className="file-icon"><FileText size={17} /></span>
              <div><strong>{file.file_name || '未命名附件'}</strong><span>{file.mime_type || '未知类型'} · {file.text_state}</span></div>
            </div>
          ))}
        </section>
      )}

      {!!message.links.length && (
        <section className="detail-section">
          <h3>文档链接</h3>
          {message.links.map(link => {
            const task = taskByLink.get(link);
            return (
              <div className="detail-link" key={link}>
                <Link2 size={15} />
                <span>{link}</span>
                {task ? <button className="button ghost small" onClick={() => onOpenTask(task.id)}>查看审批</button> : <span className="muted small">处理中</span>}
              </div>
            );
          })}
        </section>
      )}

      <section className="detail-section">
        <h3>LLM 摘要与候选</h3>
        {!(message.suggestions || []).length && <p className="muted">这条消息没有待办候选。</p>}
        {(message.suggestions || []).map(suggestion => (
          <div className="ai-card detail-ai" key={suggestion.id}>
            <div className="ai-head">
              <span className="ai-badge"><Sparkles size={13} /> 待办候选</span>
              <span className="ai-confidence">{Math.round((suggestion.confidence || 0) * 100)}%</span>
            </div>
            <h3>{suggestion.title}</h3>
            <p>{suggestion.summary || suggestion.rationale || '无摘要'}</p>
            {(suggestion.sources?.length || 0) > 1 && (
              <div className="source-list">
                <div className="source-list-title">合并的来源消息</div>
                {suggestion.sources?.map(source => (
                  <div className="source-quote" key={source.id}>
                    <strong>成员 {source.sender_id}</strong>
                    <span>{source.text || '（无正文）'}</span>
                  </div>
                ))}
              </div>
            )}
            {suggestion.status === 'pending' ? (
              <div className="ai-actions">
                <button className="button primary small" disabled={busy} onClick={() => onAccept(suggestion.id)}>保留为待办</button>
                <button className="button ghost small" disabled={busy} onClick={() => onDismiss(suggestion.id)}>忽略</button>
              </div>
            ) : <span className="category">{suggestion.status === 'accepted' ? '已保留' : '已忽略'}</span>}
          </div>
        ))}
      </section>
    </div>
  );
}

function TaskDetail({
  task,
  busy,
  onApprove,
  onCancel,
  onAnswer
}: {
  task: Task;
  busy: boolean;
  onApprove: (plan: Plan) => void;
  onCancel: () => void;
  onAnswer: (answers: Array<{key: string; value: string}>) => void;
}) {
  const plan = task.plan || null;
  const changes = plan?.plan.changes || [];
  const questions = task.questions || [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setAnswers({});
    setConfirming(false);
  }, [task.id, task.state_version]);

  function submitAnswers(event: FormEvent) {
    event.preventDefault();
    const payload = questions
      .map(question => ({key: question.key, value: (answers[question.key] || '').trim()}))
      .filter(item => item.value);
    if (payload.length !== questions.length) return;
    onAnswer(payload);
  }

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <span className="eyebrow">审批请求</span>
          <h2>文档填写 #{task.id}</h2>
          <p className="task-detail-link">{task.target_ref}</p>
        </div>
        <span className={`status-pill state-${task.state}`}>{stateLabel(task.state)}</span>
      </div>

      <div className="detail-meta-row">
        <span>版本 {task.state_version}</span>
        <span>{plan ? `计划 v${plan.version}` : '暂无计划'}</span>
        {plan?.plan.identityMode && <span>{plan.plan.identityMode === 'full' ? '姓名 + 学号' : plan.plan.identityMode === 'name_only' ? '仅姓名' : plan.plan.identityMode === 'student_id_only' ? '仅学号' : plan.plan.identityMode === 'new_row' ? '新增行' : '占位行'}</span>}
      </div>

      {task.state === 'outcome_unknown' && <div className="callout callout-error"><CircleAlert size={17} /><span>上次写入结果未知。系统只允许核对，不会自动重写。</span></div>}
      {task.state === 'paused_login_required' && <div className="callout callout-warm"><CircleAlert size={17} /><span>腾讯文档需要重新登录，完成后再恢复任务。</span></div>}

      {task.state === 'awaiting_input' && questions.length > 0 && (
        <form className="question-form" onSubmit={submitAnswers}>
          <h3>需要补充信息</h3>
          <p className="muted">这些信息只用于当前任务，不会覆盖本地资料。</p>
          {questions.map(question => (
            <label className="field" key={question.key}>
              <span>{question.label || fieldLabel(question.key)}</span>
              <input
                value={answers[question.key] || ''}
                onChange={event => setAnswers(current => ({...current, [question.key]: event.target.value}))}
                placeholder={`填写${fieldLabel(question.key)}`}
              />
            </label>
          ))}
          <button className="button primary" type="submit" disabled={busy}>保存并重新生成计划</button>
        </form>
      )}

      {plan && changes.length > 0 && (
        <section className="detail-section">
          <h3>拟填内容</h3>
          <div className="change-table">
            <div className="change-head"><span>单元格</span><span>字段</span><span>原值</span><span>拟填值</span></div>
            {changes.map(change => (
              <div className="change-row" key={`${change.row}-${change.col}`}>
                <span className="cell-ref">{cellAddress(change.row, change.col)}</span>
                <span>{fieldLabel(change.field)}</span>
                <span className={change.before ? '' : 'muted'}>{change.before || '空'}</span>
                <span className="proposed">{change.value}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {!!plan?.plan.missing?.length && (
        <section className="detail-section">
          <h3>缺少的资料</h3>
          {plan.plan.missing.map(item => <p className="muted" key={item.field}>{fieldLabel(item.field)} · {item.header || '未映射'}</p>)}
        </section>
      )}

      {!!plan?.plan.warnings?.length && <div className="callout callout-warm"><CircleAlert size={17} /><span>计划包含需要人工处理的警告，当前版本不会自动写入。</span></div>}

      <div className="detail-actions">
        {task.state === 'awaiting_approval' && plan && (
          <button
            className={`button ${confirming ? 'danger' : 'primary'}`}
            disabled={busy || changes.length === 0}
            onClick={() => { if (confirming) onApprove(plan); else setConfirming(true); }}
          >
            {confirming ? '确认写入' : '批准并写入'}
          </button>
        )}
        {['awaiting_input', 'awaiting_approval', 'approved'].includes(task.state) && (
          <button className="button ghost" disabled={busy} onClick={onCancel}>取消任务</button>
        )}
        {task.state === 'completed' && <span className="success-note"><CheckCircle2 size={16} /> 已完成，并通过独立回读</span>}
      </div>
      {confirming && <p className="confirm-note">再次点击“确认写入”才会提交审批；审批后程序会写入并回读。</p>}
    </div>
  );
}

function SettingsView({
  base,
  token,
  health,
  busy,
  onBaseChange,
  onTokenChange,
  onSave,
  onTest,
  onForget
}: {
  base: string;
  token: string;
  health: 'unknown' | 'ok' | 'down';
  busy: boolean;
  onBaseChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onSave: (event: FormEvent) => void;
  onTest: () => void;
  onForget: () => void;
}) {
  return (
    <div className="settings-wrap">
      <form className="settings-card" onSubmit={onSave}>
        <div className="settings-head">
          <span className="header-icon"><Settings size={18} /></span>
          <div>
            <h2>连接你的后台</h2>
            <p>开发时保持 <code>/api</code>，Vite 会代理到 127.0.0.1:9087。</p>
          </div>
        </div>
        <label className="field">
          <span>服务地址</span>
          <input value={base} onChange={event => onBaseChange(event.target.value)} placeholder="/api" />
        </label>
        <label className="field">
          <span>访问令牌</span>
          <input type="password" value={token} onChange={event => onTokenChange(event.target.value)} placeholder="从本机 .private/config.json 读取，不要公开" autoComplete="off" />
        </label>
        <div className="settings-actions">
          <button className="button primary" type="submit" disabled={busy}>保存设置</button>
          <button className="button ghost" type="button" disabled={busy} onClick={onTest}>测试连接</button>
          <button className="button ghost" type="button" disabled={busy || !token} onClick={onForget}>清除令牌</button>
        </div>
        <div className={`health-line ${health}`}>
          <span className={`status-dot ${health === 'ok' ? 'is-ok' : health === 'down' ? 'is-down' : ''}`} />
          {health === 'ok' ? '服务在线' : health === 'down' ? '连接失败，请检查服务是否运行' : '尚未测试连接'}
        </div>
      </form>
      <div className="privacy-card">
        <ShieldCheck size={18} />
        <h3>隐私边界</h3>
        <p>消息、附件和审批都保存在本机 SQLite；前端只读取消息和计划，不直接访问腾讯账号或浏览器会话。</p>
        <p>访问令牌存放在浏览器 localStorage，仅适合本机开发。Tauri 版本会迁移到系统安全存储。</p>
      </div>
    </div>
  );
}

function EmptyState({icon, title, body}: {icon: React.ReactNode; title: string; body: string}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

export default App;
