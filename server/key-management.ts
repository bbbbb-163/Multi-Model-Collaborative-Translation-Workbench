import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as store from "./store.ts";
import { HttpError } from "./limits.ts";
import type { AccessKey, AdminAccessKey } from "../shared/types.ts";

// Additive migration: keep the existing key hashes, IDs and JSON unchanged.
store.db.exec(`CREATE TABLE IF NOT EXISTS access_key_secrets (
  id TEXT PRIMARY KEY REFERENCES access_keys(id) ON DELETE CASCADE,
  secret TEXT NOT NULL
);`);

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function admin() {
  if (store.currentOwner() !== store.PLATFORM_OWNER)
    throw new HttpError(403, "仅管理员可以查看或重新生成分发密钥。");
}
export function adminKey(key: AccessKey): AdminAccessKey {
  admin();
  return {
    ...key,
    canReveal: !!store.db
      .prepare("SELECT 1 FROM access_key_secrets WHERE id=?")
      .get(key.id),
  };
}
export function issueKey(input: Omit<AccessKey, "id" | "hint" | "createdAt">) {
  admin();
  const secret = `mstar_${randomBytes(32).toString("base64url")}`;
  const key: AccessKey = {
    ...input,
    id: randomUUID(),
    hint: `${secret.slice(0, 12)}…${secret.slice(-4)}`,
    createdAt: store.now(),
  };
  const encrypted = store.encrypt(secret);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db
      .prepare("INSERT INTO access_keys VALUES(?,?,?)")
      .run(key.id, digest(secret), JSON.stringify(key));
    store.db
      .prepare("INSERT INTO access_key_secrets VALUES(?,?)")
      .run(key.id, encrypted);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return { key: adminKey(key), secret };
}
export function revealKey(id: string) {
  admin();
  const key = store.accessKey(id);
  if (!key) throw new HttpError(404, "密钥不存在。");
  const row = store.db
    .prepare("SELECT secret FROM access_key_secrets WHERE id=?")
    .get(id) as { secret: string } | undefined;
  if (!row)
    throw new HttpError(
      409,
      "旧密钥仅保存校验摘要，无法还原。用户再次成功登录可补存；已遗失时请重新生成密钥。",
    );
  try {
    const secret = store.decrypt(row.secret);
    const expected = store.db
      .prepare("SELECT hash FROM access_keys WHERE id=?")
      .get(id) as { hash: string };
    if (digest(secret) !== expected.hash) throw new Error("Key mismatch");
    return secret;
  } catch {
    throw new HttpError(
      409,
      "无法解密分发密钥，请检查 vault.key 和备份，或由管理员重新生成。",
    );
  }
}
// Called only after successful authentication, and independently verifies the
// supplied credential. Never replace a retained encrypted key during login.
export function captureAuthenticatedKey(id: string, secret: string) {
  const row = store.db
    .prepare("SELECT hash FROM access_keys WHERE id=?")
    .get(id) as { hash: string } | undefined;
  if (
    !row ||
    row.hash !== digest(secret) ||
    !store.keyActive(store.accessKey(id))
  )
    throw new HttpError(401, "密钥无效。");
  if (!store.db.prepare("SELECT 1 FROM access_key_secrets WHERE id=?").get(id))
    store.db
      .prepare("INSERT OR IGNORE INTO access_key_secrets VALUES(?,?)")
      .run(id, store.encrypt(secret));
}
export function rotateKey(id: string) {
  admin();
  const old = store.accessKey(id);
  if (!old) throw new HttpError(404, "密钥不存在。");
  const secret = `mstar_${randomBytes(32).toString("base64url")}`;
  const key: AccessKey = {
    ...old,
    hint: `${secret.slice(0, 12)}…${secret.slice(-4)}`,
  };
  const encrypted = store.encrypt(secret);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db
      .prepare("UPDATE access_keys SET hash=?,data=? WHERE id=?")
      .run(digest(secret), JSON.stringify(key), id);
    store.db
      .prepare(
        "INSERT INTO access_key_secrets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret",
      )
      .run(id, encrypted);
    store.db
      .prepare("DELETE FROM sessions WHERE owner=? AND kind='user'")
      .run(id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return { key: adminKey(key), secret };
}
