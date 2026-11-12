import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

// Self-contained previous eight-table layout; works in exported Docker build
// contexts too, which intentionally contain neither .git nor a git executable.
test("additive migration preserves legacy rows, credentials, ownership and vault and is idempotent", () => {
  const data = mkdtempSync(join(tmpdir(), "mstar-key-migration-"));
  mkdirSync(join(data, "files"));
  const vault = randomBytes(32);
  writeFileSync(join(data, "vault.key"), vault, { mode: 0o600 });
  const hash = (v: string | Buffer) =>
    createHash("sha256").update(v).digest("hex");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", vault, iv),
    bytes = Buffer.concat([
      cipher.update("fixture-upstream-key"),
      cipher.final(),
    ]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
    "base64",
  );
  const db = new DatabaseSync(join(data, "workbench.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
  CREATE TABLE providers(id TEXT PRIMARY KEY,data TEXT NOT NULL,secret TEXT NOT NULL,owner TEXT NOT NULL DEFAULT 'admin');
  CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL,owner TEXT NOT NULL DEFAULT 'admin');
  CREATE TABLE messages(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,data TEXT NOT NULL);
  CREATE TABLE files(id TEXT PRIMARY KEY,data TEXT NOT NULL,owner TEXT NOT NULL DEFAULT 'admin');
  CREATE TABLE catalog(id TEXT PRIMARY KEY,data TEXT NOT NULL);
  CREATE TABLE access_keys(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
  CREATE TABLE sessions(hash TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE security(id TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const now = new Date().toISOString(),
    owner = "legacy-user",
    key = "fixture-legacy-login";
  db.prepare("INSERT INTO security VALUES(?,?)").run(
    "admin-password",
    "fixture-salt:fixture-password-digest",
  );
  db.prepare("INSERT INTO access_keys VALUES(?,?,?)").run(
    owner,
    hash(key),
    JSON.stringify({
      id: owner,
      label: "Legacy",
      hint: "fixture",
      modelIds: ["mstar_legacy"],
      enabled: true,
      createdAt: now,
    }),
  );
  db.prepare("INSERT INTO providers VALUES(?,?,?,?)").run(
    "legacy-provider",
    JSON.stringify({ id: "legacy-provider", models: [] }),
    encrypted,
    "__mstar__",
  );
  db.prepare("INSERT INTO catalog VALUES(?,?)").run(
    "mstar_legacy",
    JSON.stringify({ id: "mstar_legacy", name: "Legacy" }),
  );
  db.prepare("INSERT INTO tasks VALUES(?,?,?)").run(
    "legacy-task",
    JSON.stringify({
      id: "legacy-task",
      title: "Keep history",
      running: false,
      settings: {},
    }),
    owner,
  );
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run(
    "legacy-message",
    "legacy-task",
    JSON.stringify({ role: "user", content: "Keep content", status: "done" }),
  );
  db.prepare("INSERT INTO files VALUES(?,?,?)").run(
    "legacy-file",
    JSON.stringify({ name: "fixture.txt", size: 4 }),
    owner,
  );
  writeFileSync(join(data, "files/legacy-file"), "Keep");
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
    "fixture-session",
    owner,
    "user",
    Date.now() + 86400000,
  );
  const snapshot = (d: DatabaseSync) =>
    Object.fromEntries(
      [
        "providers",
        "tasks",
        "messages",
        "files",
        "catalog",
        "access_keys",
        "sessions",
        "security",
      ].map((n) => [
        n,
        hash(
          JSON.stringify(
            d
              .prepare(
                "SELECT * FROM " +
                  n +
                  (n === "security" ? " WHERE id='admin-password'" : "") +
                  " ORDER BY 1",
              )
              .all(),
          ),
        ),
      ]),
    );
  const before = snapshot(db);
  db.close();
  const script = `import * as s from ${JSON.stringify(pathToFileURL(resolve("server/store.ts")).href)};await import(${JSON.stringify(pathToFileURL(resolve("server/app.ts")).href)});import {createHash} from 'node:crypto';console.log(JSON.stringify({providerHash:s.withOwner(s.PLATFORM_OWNER,()=>createHash('sha256').update(s.providerKey('legacy-provider')).digest('hex'))}));s.db.close();`;
  for (let i = 0; i < 2; i++) {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { encoding: "utf8", env: { ...process.env, WORKBENCH_DATA: data } },
      ),
    );
    assert.equal(result.providerHash, hash("fixture-upstream-key"));
    const upgraded = new DatabaseSync(join(data, "workbench.sqlite"));
    assert.deepEqual(snapshot(upgraded), before);
    assert.equal(
      (
        upgraded
          .prepare(
            "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as any
      ).n,
      10,
    );
    assert.equal(
      upgraded
        .prepare("SELECT id FROM access_keys WHERE hash=?")
        .get(hash(key))!.id,
      owner,
    );
    assert.equal(
      upgraded.prepare("SELECT owner FROM tasks WHERE id='legacy-task'").get()!
        .owner,
      owner,
    );
    assert.equal(
      (
        upgraded
          .prepare("SELECT COUNT(*) n FROM access_key_secrets")
          .get() as any
      ).n,
      0,
      "Never fabricate a legacy secret",
    );
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
    upgraded.close();
    assert.deepEqual(readFileSync(join(data, "vault.key")), vault);
    assert.equal(readFileSync(join(data, "files/legacy-file"), "utf8"), "Keep");
  }
});
