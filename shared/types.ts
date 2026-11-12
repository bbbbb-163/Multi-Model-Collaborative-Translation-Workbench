export type Protocol = "compatible" | "openai" | "anthropic" | "google";
export const AUTO_CAPABILITY = "auto";
export type InputModality = "text" | "image" | "audio" | "video" | "file";
export interface InputConstraint {
  accepted: InputModality[];
  required?: InputModality[];
}
export interface Capability {
  id: string;
  label: string;
  description: string;
  input: "text" | "file" | "any";
}
export interface CustomCapability {
  id: string;
  label: string;
  path: string;
  method?: "POST" | "GET";
  body?: Record<string, unknown>;
  resultPath?: string;
  output?: "text" | "image" | "video" | "audio" | "json";
  poll?: {
    path: string;
    statusPath: string;
    complete: string;
    failed?: string;
    resultPath: string;
  };
}
export interface Model {
  id: string;
  name: string;
  capabilities: string[];
  source: "metadata" | "inferred" | "manual";
  contextWindow?: number;
  description?: string;
  tools?: boolean;
  inputConstraints?: Record<string, InputConstraint>;
}
export interface Provider {
  id: string;
  name: string;
  url: string;
  protocol: Protocol;
  models: Model[];
  hasKey: boolean;
  keyHint: string;
  createdAt: string;
  customCapabilities: CustomCapability[];
}
export interface MstarProvider {
  id: string;
  name: string;
  managed: true;
  models: Model[];
  customCapabilities: [];
}
export type WorkspaceProvider = Provider | MstarProvider;
export interface CatalogModel {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  capabilities: string[];
  published: boolean;
  testedAt?: string;
  testedCapabilities: string[];
  createdAt: string;
}
export interface AccessKey {
  id: string;
  label: string;
  hint: string;
  modelIds: string[];
  enabled: boolean;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}
export interface AdminAccessKey extends AccessKey {
  canReveal: boolean;
}
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
export type RequestStatus =
  "running" | "success" | "error" | "cancelled" | "interrupted";
export interface ModelRequest {
  id: string;
  modelId: string;
  modelName: string;
  capability: string;
  status: RequestStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  images: number;
  audio: number;
  video: number;
  outputBytes: number;
}
export interface RequestTotals {
  requests: number;
  success: number;
  failed: number;
  cancelled: number;
  running: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  unreported: number;
  images: number;
  audio: number;
  video: number;
  outputBytes: number;
}
export interface KeyUsageReport {
  trackedSince: string;
  totals: RequestTotals;
  models: (RequestTotals & { modelId: string; modelName: string })[];
  availableModels: { id: string; name: string }[];
  records: ModelRequest[];
  page: number;
  pageSize: number;
  total: number;
}
export interface Identity {
  id: string;
  label: string;
  role: "admin" | "user";
}
export interface Selection {
  providerId: string;
  modelId: string;
  role: string;
}
export interface WorkflowStep {
  id: string;
  providerId: string;
  modelId: string;
  capability: string;
  prompt: string;
  inputSource: "previous" | "original" | "all";
  optionsJson: string;
}
export interface TaskSettings {
  mode: "direct" | "team" | "workflow";
  selections: Selection[];
  primary?: string;
  capability: string;
  rounds: number; // Legacy field; executions normalize to one work pass.
  continuous?: boolean; // Legacy field; continuous discussion is disabled.
  maxCalls: number;
  systemPrompt: string;
  workflow?: WorkflowStep[];
}
export interface Task {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  settings: TaskSettings;
  running: boolean;
}
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  url: string;
  size: number;
}
export interface Message {
  id: string;
  taskId: string;
  runId?: string;
  role: "user" | "assistant" | "activity" | "error";
  content: string;
  model?: string;
  stage?: string;
  status: "running" | "done" | "error" | "cancelled";
  attachments: Attachment[];
  createdAt: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  confirmation?: {
    kind: "supported-inputs";
    state: "pending" | "accepted" | "rejected" | "cancelled" | "expired";
    acceptLabel: string;
  };
}
export interface TaskDetail extends Task {
  messages: Message[];
}
export const refKey = (s: Pick<Selection, "providerId" | "modelId">) =>
  `${s.providerId}::${s.modelId}`;
