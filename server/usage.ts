import { randomUUID } from "node:crypto";
import * as store from "./store.ts";
import { HttpError } from "./limits.ts";
import type {
  Attachment,
  KeyUsageReport,
  ModelRequest,
  RequestStatus,
  RequestTotals,
  TokenUsage,
} from "../shared/types.ts";

// Independent ledger: deleting a task/message or changing model grants must not
// erase request accounting. No prompts, outputs, keys or upstream errors here.
store.db.exec(`CREATE TABLE IF NOT EXISTS model_requests (
 id TEXT PRIMARY KEY, key_id TEXT NOT NULL, model_id TEXT NOT NULL,
 model_name TEXT NOT NULL, capability TEXT NOT NULL, task_id TEXT NOT NULL,
 message_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
 finished_at TEXT, duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
 total_tokens INTEGER, images INTEGER NOT NULL DEFAULT 0, audio INTEGER NOT NULL DEFAULT 0,
 video INTEGER NOT NULL DEFAULT 0, output_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS model_requests_key_time ON model_requests(key_id,started_at,id);
CREATE INDEX IF NOT EXISTS model_requests_key_model ON model_requests(key_id,model_id,started_at);
CREATE INDEX IF NOT EXISTS model_requests_key_status ON model_requests(key_id,status,started_at);`);
store.db
  .prepare(
    "INSERT OR IGNORE INTO security VALUES('request-usage-started-at',?)",
  )
  .run(store.now());
store.db
  .prepare(
    "UPDATE model_requests SET status='interrupted',finished_at=? WHERE status='running'",
  )
  .run(store.now());

export function normalizedUsage(value: TokenUsage): TokenUsage {
  const number = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  const inputTokens = number(value.inputTokens),
    outputTokens = number(value.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      number(value.totalTokens) ??
      (inputTokens !== undefined &&
      outputTokens !== undefined &&
      Number.isSafeInteger(inputTokens + outputTokens)
        ? inputTokens + outputTokens
        : undefined),
  };
}
export function usageFromResponse(value: any): TokenUsage {
  const u = value?.usage ?? value?.usageMetadata ?? {};
  return normalizedUsage({
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount,
    outputTokens:
      u.output_tokens ?? u.completion_tokens ?? u.candidatesTokenCount,
    totalTokens: u.total_tokens ?? u.totalTokenCount,
  });
}
export function startModelRequest(
  modelId: string,
  capability: string,
  taskId: string,
  messageId: string,
) {
  const owner = store.currentOwner();
  if (owner === store.ADMIN_OWNER || owner === store.PLATFORM_OWNER)
    return undefined;
  const model = store.authorizedCatalog(modelId);
  const id = randomUUID();
  store.db
    .prepare(
      `INSERT INTO model_requests
    (id,key_id,model_id,model_name,capability,task_id,message_id,status,started_at)
    VALUES(?,?,?,?,?,?,?,'running',?)`,
    )
    .run(
      id,
      owner,
      modelId,
      model.name,
      capability,
      taskId,
      messageId,
      store.now(),
    );
  return id;
}
export function finishModelRequest(
  id: string | undefined,
  status: Exclude<RequestStatus, "running">,
  usage: TokenUsage = {},
  attachments: Pick<Attachment, "mime" | "size">[] = [],
) {
  if (!id) return;
  const tokens = normalizedUsage(usage),
    now = store.now();
  const count = (kind: string) =>
    attachments.filter((a) => a.mime.startsWith(kind + "/")).length;
  store.db
    .prepare(
      `UPDATE model_requests SET status=?,finished_at=?,
    duration_ms=MAX(0,CAST(ROUND((julianday(?)-julianday(started_at))*86400000) AS INTEGER)),
    input_tokens=?,output_tokens=?,total_tokens=?,images=?,audio=?,video=?,output_bytes=?
    WHERE id=? AND key_id=?`,
    )
    .run(
      status,
      now,
      now,
      tokens.inputTokens ?? null,
      tokens.outputTokens ?? null,
      tokens.totalTokens ?? null,
      count("image"),
      count("audio"),
      count("video"),
      attachments.reduce((n, a) => n + a.size, 0),
      id,
      store.currentOwner(),
    );
}
export interface UsageFilter {
  from?: string;
  to?: string;
  modelId?: string;
  status?: RequestStatus;
  page: number;
}
const totals = `COUNT(*) AS requests,
 COALESCE(SUM(status='success'),0) AS success,
 COALESCE(SUM(status IN ('error','interrupted')),0) AS failed,
 COALESCE(SUM(status='cancelled'),0) AS cancelled,
 COALESCE(SUM(status='running'),0) AS running,
 SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,SUM(total_tokens) AS totalTokens,
 COALESCE(SUM(input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL),0) AS unreported,
 COALESCE(SUM(images),0) AS images,COALESCE(SUM(audio),0) AS audio,
 COALESCE(SUM(video),0) AS video,COALESCE(SUM(output_bytes),0) AS outputBytes`;
export function keyUsage(id: string, filter: UsageFilter): KeyUsageReport {
  if (store.currentOwner() !== store.PLATFORM_OWNER)
    throw new HttpError(403, "仅管理员可以查看用量。");
  if (!store.accessKey(id)) throw new HttpError(404, "密钥不存在。");
  const where = ["key_id=?"],
    values: (string | number)[] = [id];
  if (filter.from) {
    where.push("started_at>=?");
    values.push(filter.from);
  }
  if (filter.to) {
    where.push("started_at<?");
    values.push(filter.to);
  }
  if (filter.modelId) {
    where.push("model_id=?");
    values.push(filter.modelId);
  }
  if (filter.status) {
    where.push("status=?");
    values.push(filter.status);
  }
  const clause = " WHERE " + where.join(" AND ");
  const summary = store.db
    .prepare("SELECT " + totals + " FROM model_requests" + clause)
    .get(...values) as unknown as RequestTotals;
  const names = new Map(store.catalogModels().map((m) => [m.id, m.name]));
  const available = store.db
    .prepare(
      "SELECT model_id AS id,model_name AS name,MAX(started_at) AS latest FROM model_requests WHERE key_id=? GROUP BY model_id ORDER BY latest DESC",
    )
    .all(id) as { id: string; name: string }[];
  for (const m of available) if (!names.has(m.id)) names.set(m.id, m.name);
  const models = store.db
    .prepare(
      "SELECT model_id AS modelId," +
        totals +
        " FROM model_requests" +
        clause +
        " GROUP BY model_id ORDER BY requests DESC,model_id",
    )
    .all(...values) as unknown as (RequestTotals & { modelId: string })[];
  const pageSize = 25,
    pages = Math.max(1, Math.ceil(summary.requests / pageSize)),
    page = Math.min(filter.page, pages);
  const records = store.db
    .prepare(
      `SELECT id,model_id AS modelId,model_name AS modelName,capability,status,
   started_at AS startedAt,finished_at AS finishedAt,duration_ms AS durationMs,
   input_tokens AS inputTokens,output_tokens AS outputTokens,total_tokens AS totalTokens,
   images,audio,video,output_bytes AS outputBytes FROM model_requests` +
        clause +
        " ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?",
    )
    .all(
      ...values,
      pageSize,
      (page - 1) * pageSize,
    ) as unknown as ModelRequest[];
  const tracked = store.db
    .prepare("SELECT value FROM security WHERE id='request-usage-started-at'")
    .get() as { value: string };
  return {
    trackedSince: tracked.value,
    totals: summary,
    models: models.map((m) => ({
      ...m,
      modelName: names.get(m.modelId) || m.modelId,
    })),
    availableModels: available.map((m) => ({
      id: m.id,
      name: names.get(m.id) || m.name,
    })),
    records,
    page,
    pageSize,
    total: summary.requests,
  };
}
