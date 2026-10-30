export interface MessageFile {
  id: number;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  download_state: string;
  text_state: string;
}

export interface Message {
  id: number;
  platform: string;
  conversation: { type: string; id: string };
  sender: { id: string };
  source_time: string | null;
  received_at: string;
  kind: string;
  text: string | null;
  links: string[];
  files: MessageFile[];
  read: boolean;
  suggestions?: Suggestion[];
}

export interface Suggestion {
  id: number;
  message_id: number;
  kind: string;
  title: string;
  summary: string | null;
  category: string;
  confidence: number | null;
  status: 'pending' | 'accepted' | 'dismissed' | string;
  rationale: string | null;
  created_at: string;
  decided_at: string | null;
  links: string[];
  message_text?: string | null;
  sender_id?: string;
  conversation_id?: string;
  received_at?: string;
  thread_key?: string | null;
  source_count?: number;
  sources?: Array<{id: number; sender_id: string; received_at: string; text: string | null}>;
}

export interface SourceRow {
  conversation_type: string;
  conversation_id: string;
  total: number;
  unread: number;
  last_at: string;
  last_sender_id: string;
  last_text: string | null;
}

export interface Todo {
  id: number;
  title: string;
  status: string;
  priority: number;
  due_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskQuestion {
  key: string;
  label: string;
  kind: string;
  reason: string | null;
}

export interface PlanChange {
  row: number;
  col: number;
  field: string;
  before?: string;
  value?: string;
  replaces_placeholder?: boolean;
}

export interface PlanPayload {
  headerRow?: number;
  identityRow?: number;
  identityMode?: 'full' | 'name_only' | 'reserved' | string;
  nameCol?: number;
  studentCol?: number;
  changes?: PlanChange[];
  missing?: Array<{field: string; header?: string; reason?: string}>;
  warnings?: Array<{field?: string; reason?: string}>;
  document?: string;
  confidence?: number | null;
  notes?: string;
}

export interface Plan {
  id: number;
  task_id: number;
  version: number;
  kind: string;
  document_ref: string;
  digest: string;
  plan: PlanPayload;
  status: string;
  created_at: string;
}

export interface Task {
  id: number;
  todo_id: number | null;
  kind: string;
  executor_type: string;
  account_ref: string;
  target_ref: string;
  state: string;
  state_version: number;
  waiting_reason: string | null;
  current_plan_id: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  plan?: Plan | null;
  questions?: TaskQuestion[];
  answers?: Array<{key: string; value: string}>;
}

export interface Operation {
  id: number;
  task_id: number;
  plan_id: number;
  kind: string;
  state: string;
  attempt: number;
  evidence_json: string | null;
  error_class: string | null;
  started_at: string | null;
  finished_at: string | null;
  idempotency_key: string;
}

export type View = 'inbox' | 'todos' | 'approvals' | 'settings';
