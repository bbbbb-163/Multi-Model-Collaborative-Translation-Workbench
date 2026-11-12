import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { limits, HttpError } from "./limits.ts";
import { AUTO_CAPABILITY } from "../shared/types.ts";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import type {
  Provider,
  Task,
  TaskSettings,
  Message,
  Attachment,
  CatalogModel,
  AccessKey,
  WorkspaceProvider,
} from "../shared/types.ts";

export const ADMIN_OWNER = "admin";
export const PLATFORM_OWNER = "__mstar__";
const owners = new AsyncLocalStorage<string>();
export const hasOwnerContext = () => !!owners.getStore();
export const currentOwner = () => {
  const owner = owners.getStore();
  if (!owner) throw new Error("缺少身份上下文，已拒绝数据访问。");
  return owner;
};
export const withOwner = <T>(owner: string, fn: () => T): T =>
  owners.run(owner, fn);
export type RuntimeProvider = Provider & {
  managed?: true;
  upstreamModelId?: string;
};

export const dataDir = resolve(process.env.WORKBENCH_DATA || ".data");
for (const publicRoot of [resolve("dist"), resolve("public")]) {
  const relative = dataDir.slice(publicRoot.length);
  if (
    dataDir.toLowerCase() === publicRoot.toLowerCase() ||
    (dataDir.toLowerCase().startsWith(publicRoot.toLowerCase()) &&
      /^[\\/]/.test(relative))
  )
    throw new Error("WORKBENCH_DATA 不能放在 dist 或 public 静态目录中。");
}
export const filesDir = join(dataDir, "files");
mkdirSync(filesDir, { recursive: true });
const keyPath = join(dataDir, "vault.key");
if (!existsSync(keyPath))
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
const vaultKey = readFileSync(keyPath);
export function encrypt(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", vaultKey, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
export function decrypt(value: string) {
  const bytes = Buffer.from(value, "base64"),
    decipher = createDecipheriv("aes-256-gcm", vaultKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
const db = new DatabaseSync(join(dataDir, "workbench.sqlite"));
export { db };
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, data TEXT NOT NULL, secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS access_keys (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS security (id TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// Existing local records belong to the administrator; never assign them to the first customer.
for (const table of ["providers", "tasks", "files"]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === "owner"))
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN owner TEXT NOT NULL DEFAULT 'admin'`,
    );
  db.exec(`CREATE INDEX IF NOT EXISTS ${table}_owner ON ${table}(owner)`);
}
const parse = <T>(row: unknown): T | undefined =>
  row ? JSON.parse((row as { data: string }).data) : undefined;
export const now = () => new Date().toISOString();
export function providers(): Provider[] {
  return db
    .prepare("SELECT data FROM providers WHERE owner=? ORDER BY rowid")
    .all(currentOwner())
    .map((r) => parse<Provider>(r)!);
}
export function provider(id: string) {
  return parse<Provider>(
    db
      .prepare("SELECT data FROM providers WHERE id=? AND owner=?")
      .get(id, currentOwner()),
  );
}
export function providerKey(id: string): string {
  if (id.startsWith("mstar_")) {
    const entry = authorizedCatalog(id);
    return withOwner(PLATFORM_OWNER, () => providerKey(entry.providerId));
  }
  const row = db
    .prepare("SELECT secret FROM providers WHERE id=? AND owner=?")
    .get(id, currentOwner()) as { secret: string } | undefined;
  if (!row) throw new Error("连接已移除，请重新添加。");
  return decrypt(row.secret);
}
export function putProvider(p: Provider, key?: string) {
  const secret =
    key === undefined
      ? (
          db
            .prepare("SELECT secret FROM providers WHERE id=? AND owner=?")
            .get(p.id, currentOwner()) as {
            secret: string;
          }
        )?.secret
      : encrypt(key);
  if (secret === undefined) throw new Error("缺少 API Key");
  db.prepare(
    "INSERT INTO providers(id,data,secret,owner) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,secret=excluded.secret WHERE providers.owner=excluded.owner",
  ).run(p.id, JSON.stringify(p), secret, currentOwner());
  return p;
}
export function deleteProvider(id: string) {
  db.prepare("DELETE FROM providers WHERE id=? AND owner=?").run(
    id,
    currentOwner(),
  );
}
export const defaultSettings = (): TaskSettings => ({
  mode: "direct",
  selections: [],
  capability: AUTO_CAPABILITY,
  rounds: 1,
  continuous: false,
  maxCalls: 16,
  systemPrompt: "",
});
export function tasks(): Task[] {
  return db
    .prepare(
      "SELECT data FROM tasks WHERE owner=? ORDER BY json_extract(data,'$.updatedAt') DESC",
    )
    .all(currentOwner())
    .map((r) => parse<Task>(r)!);
}
export function task(id: string) {
  return parse<Task>(
    db
      .prepare("SELECT data FROM tasks WHERE id=? AND owner=?")
      .get(id, currentOwner()),
  );
}
export function putTask(t: Task) {
  db.prepare(
    "INSERT INTO tasks(id,data,owner) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE tasks.owner=excluded.owner",
  ).run(t.id, JSON.stringify(t), currentOwner());
  return t;
}
export function createTask(title = "新任务") {
  return putTask({
    id: randomUUID(),
    title,
    createdAt: now(),
    updatedAt: now(),
    settings: defaultSettings(),
    running: false,
  });
}
export function deleteTask(id: string) {
  db.prepare("DELETE FROM tasks WHERE id=? AND owner=?").run(
    id,
    currentOwner(),
  );
}
export function messages(taskId: string): Message[] {
  if (!task(taskId)) return [];
  return db
    .prepare("SELECT data FROM messages WHERE task_id=? ORDER BY rowid")
    .all(taskId)
    .map((r) => parse<Message>(r)!);
}
export function putMessage(m: Message) {
  if (!task(m.taskId)) throw new Error("任务不存在。");
  db.prepare(
    "INSERT INTO messages VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE messages.task_id=excluded.task_id",
  ).run(m.id, m.taskId, JSON.stringify(m));
  return m;
}
export function message(id: string) {
  const result = parse<Message>(
    db.prepare("SELECT data FROM messages WHERE id=?").get(id),
  );
  return result && task(result.taskId) ? result : undefined;
}
export function putFile(a: Attachment) {
  db.prepare("INSERT INTO files(id,data,owner) VALUES(?,?,?)").run(
    a.id,
    JSON.stringify(a),
    currentOwner(),
  );
  return a;
}
export function file(id: string) {
  return parse<Attachment>(
    db
      .prepare("SELECT data FROM files WHERE id=? AND owner=?")
      .get(id, currentOwner()),
  );
}
export function saveFile(
  name: string,
  mime: string,
  data: Uint8Array,
): Attachment {
  const owner = currentOwner();
  assertStorageCapacity(data.length);
  const id = randomUUID();
  writeFileSync(join(filesDir, id), data);
  try {
    return putFile({
      id,
      name: name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 160),
      mime,
      size: data.length,
      url: `${owner === PLATFORM_OWNER ? "/api/admin" : "/api"}/files/${id}`,
    });
  } catch (error) {
    unlinkSync(join(filesDir, id));
    throw error;
  }
}
export function assertStorageCapacity(bytes: number, singleFile = true) {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(json_extract(data,'$.size')),0) AS bytes FROM files WHERE owner=?",
    )
    .get(currentOwner()) as { bytes: number };
  if (
    (singleFile && bytes > 200 * 1024 * 1024) ||
    row.bytes + bytes > limits.storageBytes
  )
    throw new HttpError(
      413,
      "文件超过大小限制或工作空间存储空间不足，请联系管理员调整存储额度。",
    );
}
export function deleteFile(id: string) {
  if (!file(id) || !/^[a-f0-9-]{36}$/.test(id)) return;
  if (existsSync(join(filesDir, id))) unlinkSync(join(filesDir, id));
  db.prepare("DELETE FROM files WHERE id=? AND owner=?").run(
    id,
    currentOwner(),
  );
}
export function catalogModels(): CatalogModel[] {
  currentOwner();
  return db
    .prepare("SELECT data FROM catalog ORDER BY rowid")
    .all()
    .map((r) => parse<CatalogModel>(r)!);
}
export function catalogModel(id: string) {
  currentOwner();
  return parse<CatalogModel>(
    db.prepare("SELECT data FROM catalog WHERE id=?").get(id),
  );
}
export function putCatalogModel(m: CatalogModel) {
  if (currentOwner() !== PLATFORM_OWNER)
    throw new Error("缺少管理员操作权限。");
  db.prepare(
    "INSERT INTO catalog VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
  ).run(m.id, JSON.stringify(m));
  return m;
}
export function accessKeys(): AccessKey[] {
  if (currentOwner() !== PLATFORM_OWNER)
    throw new Error("缺少管理员操作权限。");
  return db
    .prepare("SELECT data FROM access_keys ORDER BY rowid DESC")
    .all()
    .map((r) => parse<AccessKey>(r)!);
}
export function accessKey(id: string) {
  return parse<AccessKey>(
    db.prepare("SELECT data FROM access_keys WHERE id=?").get(id),
  );
}
export function keyActive(k: AccessKey | undefined): k is AccessKey {
  return (
    !!k && k.enabled && (!k.expiresAt || Date.parse(k.expiresAt) > Date.now())
  );
}
export function putAccessKey(k: AccessKey) {
  if (currentOwner() !== PLATFORM_OWNER)
    throw new Error("缺少管理员操作权限。");
  db.prepare("UPDATE access_keys SET data=? WHERE id=?").run(
    JSON.stringify(k),
    k.id,
  );
  return k;
}
export function authorizedCatalog(id: string) {
  const m = catalogModel(id),
    owner = currentOwner(),
    k = accessKey(owner);
  if (
    !m?.published ||
    (owner !== ADMIN_OWNER && (!keyActive(k) || !k.modelIds.includes(id)))
  )
    throw new Error("此模型已下架或当前密钥没有使用权限，请刷新模型列表。");
  return m;
}
export function runtimeProvider(id: string): RuntimeProvider | undefined {
  if (!id.startsWith("mstar_")) return provider(id);
  const entry = authorizedCatalog(id);
  const upstream = withOwner(PLATFORM_OWNER, () => provider(entry.providerId));
  const model = upstream?.models.find((m) => m.id === entry.modelId);
  if (!upstream || !model) throw new Error("此模型暂不可用，请联系管理员。");
  return {
    ...upstream,
    id: entry.id,
    name: entry.name,
    managed: true,
    upstreamModelId: entry.modelId,
    models: [
      {
        id: entry.id,
        name: entry.name,
        capabilities: entry.capabilities,
        source: "manual",
        tools: model.tools,
        inputConstraints: model.inputConstraints,
      },
    ],
  };
}
export function workspaceProviders(): WorkspaceProvider[] {
  const owner = currentOwner(),
    k = accessKey(owner);
  const managed: WorkspaceProvider[] = catalogModels()
    .filter(
      (m) =>
        m.published &&
        (owner === ADMIN_OWNER || (keyActive(k) && k.modelIds.includes(m.id))),
    )
    .map((m) => ({
      id: m.id,
      name: m.name,
      managed: true,
      customCapabilities: [],
      models: [
        {
          id: m.id,
          name: m.name,
          capabilities: m.capabilities,
          source: "manual",
        },
      ],
    }));
  return [...managed, ...providers()];
}
export function publicCapabilities() {
  const definitions = workspaceProviders()
    .filter((p) => "managed" in p)
    .flatMap((p) => {
      const entry = catalogModel(p.id)!;
      const upstream = withOwner(PLATFORM_OWNER, () =>
        provider(entry.providerId),
      );
      return (upstream?.customCapabilities || []).filter((c) =>
        entry.capabilities.includes(c.id),
      );
    });
  return [...new Map(definitions.map((c) => [c.id, c])).values()].map((c) => ({
    id: c.id,
    label: c.label,
    description: "",
    input: "any" as const,
  }));
}
// Restore every owner's interrupted tasks without making their data visible to other owners.
for (const row of db
  .prepare("SELECT owner FROM tasks GROUP BY owner")
  .all() as { owner: string }[])
  withOwner(row.owner, () => {
    for (const t of tasks().filter((t) => t.running)) {
      putTask({ ...t, running: false });
      for (const m of messages(t.id).filter((m) => m.status === "running"))
        putMessage({ ...m, status: "cancelled" });
      for (const m of messages(t.id).filter(
        (m) => m.confirmation?.state === "pending",
      ))
        putMessage({
          ...m,
          confirmation: { ...m.confirmation!, state: "cancelled" },
        });
      putMessage({
        id: randomUUID(),
        taskId: t.id,
        role: "error",
        content: "服务已重启，上次运行已中断。可以重新发送继续。",
        status: "error",
        attachments: [],
        createdAt: now(),
      });
    }
  });
