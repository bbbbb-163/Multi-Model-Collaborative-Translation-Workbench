import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";

process.env.WORKBENCH_DATA = mkdtempSync(join(tmpdir(), "mstar-key-usage-"));
const store = await import("../server/store.ts");
const { createApp } = await import("../server/app.ts");
const { setupCode, hash } = await import("../server/auth.ts");
const keyStore = await import("../server/key-management.ts");
const usageStore = await import("../server/usage.ts");
let server: Server,
  upstream: Server,
  base: string,
  admin: string,
  alice: string,
  bob: string,
  aliceKey: any,
  bobKey: any;
let mode: "normal" | "error" | "slow" | "fallback" | "steps" = "normal",
  requests = 0;
const textId = "mstar_usage_text",
  imageId = "mstar_usage_image";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=";
async function request(
  path: string,
  cookie = admin,
  method = "GET",
  body?: unknown,
) {
  return fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function api(
  path: string,
  cookie = admin,
  method = "GET",
  body?: unknown,
) {
  const r = await request(path, cookie, method, body);
  const v = await r.json();
  assert.ok(r.ok, `${path}: ${JSON.stringify(v)}`);
  return v;
}
async function login(secret: string) {
  const r = await request("/auth/login", "", "POST", { key: secret });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
async function run(model: string, content = "fixture") {
  const t = await api("/tasks", alice, "POST", {});
  await api(`/tasks/${t.id}`, alice, "PATCH", {
    settings: {
      ...t.settings,
      selections: [{ providerId: model, modelId: model, role: "" }],
      primary: `${model}::${model}`,
      capability: model === imageId ? "image" : "text",
    },
  });
  await api(`/tasks/${t.id}/run`, alice, "POST", { content });
  return t;
}
async function settled(id: string) {
  for (let i = 0; i < 150; i++) {
    const t = await api(`/tasks/${id}`, alice);
    if (!t.running) return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Run timeout");
}
before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("Content-Type", "application/json");
    requests++;
    if (mode === "error" || (mode === "fallback" && body.tools?.length)) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: {
            message:
              mode === "fallback"
                ? "tools are not supported"
                : "fixture failure",
          },
        }),
      );
      return;
    }
    if (mode === "slow") await new Promise((r) => setTimeout(r, 200));
    if (req.url === "/v1/images/generations") {
      res.end(
        JSON.stringify({
          data: [{ b64_json: png }],
          usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 },
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    if (
      mode === "steps" &&
      !body.messages.some((m: any) => m.role === "tool")
    ) {
      const chunk = (delta: any, finish: string | null) =>
        `data: ${JSON.stringify({ id: "u", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fixture-save",
                type: "function",
                function: {
                  name: "save_file",
                  arguments: JSON.stringify({
                    name: "fixture.txt",
                    content: "fixture",
                  }),
                },
              },
            ],
          },
          null,
        ) +
          chunk({}, "tool_calls") +
          `data: ${JSON.stringify({ id: "u", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    res.end(
      `data: ${JSON.stringify({ id: "u", choices: [{ index: 0, delta: { content: "fixture response" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "u", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ id: "u", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  store.withOwner(store.PLATFORM_OWNER, () => {
    store.putProvider(
      {
        id: "usage-provider",
        name: "Fixture",
        url: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
        protocol: "compatible",
        models: [
          {
            id: "text-engine",
            name: "Text",
            capabilities: ["text"],
            source: "manual",
            tools: true,
          },
          {
            id: "image-engine",
            name: "Image",
            capabilities: ["image"],
            source: "manual",
          },
        ],
        hasKey: true,
        keyHint: "fixture",
        createdAt: store.now(),
        customCapabilities: [],
      },
      "fixture-provider-secret",
    );
    for (const [id, modelId, name, cap] of [
      [textId, "text-engine", "文字助手", "text"],
      [imageId, "image-engine", "图片助手", "image"],
    ])
      store.putCatalogModel({
        id,
        modelId,
        name,
        capabilities: [cap],
        providerId: "usage-provider",
        published: true,
        testedCapabilities: [cap],
        createdAt: store.now(),
      });
  });
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const r = await request("/auth/setup", "", "POST", {
    code: setupCode(),
    password: "fixture-admin-password-123",
  });
  assert.equal(r.status, 200);
  admin = r.headers.get("set-cookie")!.split(";")[0];
  aliceKey = await api("/admin/keys", admin, "POST", {
    label: "Alice",
    modelIds: [textId, imageId],
  });
  bobKey = await api("/admin/keys", admin, "POST", {
    label: "Bob",
    modelIds: [textId],
  });
  alice = await login(aliceKey.secret);
  bob = await login(bobKey.secret);
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  upstream?.closeAllConnections();
  upstream?.close();
});

test("full distributed credentials are encrypted and revealed only to authenticated administrators", async () => {
  const record = store.db
    .prepare("SELECT secret FROM access_key_secrets WHERE id=?")
    .get(aliceKey.key.id) as any;
  assert.notEqual(record.secret, aliceKey.secret);
  assert.equal(store.decrypt(record.secret), aliceKey.secret);
  assert.ok(
    !JSON.stringify(
      store.db.prepare("SELECT * FROM access_keys").all(),
    ).includes(aliceKey.secret),
  );
  const r = await request(
    `/admin/keys/${aliceKey.key.id}/secret`,
    admin,
    "POST",
    {},
  );
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control")!, /no-store/);
  assert.equal((await r.json()).secret, aliceKey.secret);
  for (const cookie of ["", alice, bob]) {
    for (const path of ["secret", "rotate"])
      assert.equal(
        (
          await request(
            `/admin/keys/${aliceKey.key.id}/${path}`,
            cookie,
            "POST",
            {},
          )
        ).status,
        401,
      );
    assert.equal(
      (await request(`/admin/keys/${aliceKey.key.id}/usage`, cookie)).status,
      401,
    );
  }
  const metadata = await api("/admin/bootstrap");
  assert.equal(
    metadata.keys.find((k: any) => k.id === aliceKey.key.id).canReveal,
    true,
  );
  assert.ok(!JSON.stringify(metadata).includes(aliceKey.secret));
  assert.ok(!JSON.stringify(metadata).includes(record.secret));
});
test("legacy hashes remain usable, are never fabricated, and gain encrypted recovery only after a valid login", async () => {
  const secret = "mstar_legacy-fixture-not-a-production-key";
  const k = {
    id: "legacy-key",
    label: "Legacy",
    hint: "mstar_legacy…key",
    modelIds: [textId],
    enabled: true,
    createdAt: store.now(),
  };
  store.db
    .prepare("INSERT INTO access_keys VALUES(?,?,?)")
    .run(k.id, hash(secret), JSON.stringify(k));
  assert.equal(
    (await request(`/admin/keys/${k.id}/secret`, admin, "POST", {})).status,
    409,
  );
  assert.equal(
    (await request("/auth/login", "", "POST", { key: "wrong legacy key" }))
      .status,
    401,
  );
  assert.equal(
    store.db.prepare("SELECT 1 FROM access_key_secrets WHERE id=?").get(k.id),
    undefined,
  );
  await login(secret);
  assert.equal(
    (await api(`/admin/keys/${k.id}/secret`, admin, "POST", {})).secret,
    secret,
  );
  assert.equal(
    (
      store.db
        .prepare("SELECT hash FROM access_keys WHERE id=?")
        .get(k.id) as any
    ).hash,
    hash(secret),
  );
  const encrypted = (
    store.db
      .prepare("SELECT secret FROM access_key_secrets WHERE id=?")
      .get(k.id) as any
  ).secret;
  await login(secret);
  assert.equal(
    (
      store.db
        .prepare("SELECT secret FROM access_key_secrets WHERE id=?")
        .get(k.id) as any
    ).secret,
    encrypted,
  );
});
test("actual managed text and image calls retain per-key token and output usage without leaking to users", async () => {
  const t = await run(textId);
  const detail = await settled(t.id);
  assert.ok(!JSON.stringify(detail).includes("inputTokens"));
  const image = await run(imageId);
  await settled(image.id);
  const report = await api(`/admin/keys/${aliceKey.key.id}/usage`);
  assert.equal(report.total, 2);
  assert.equal(report.totals.success, 2);
  assert.equal(report.totals.inputTokens, 14);
  assert.equal(report.totals.outputTokens, 13);
  assert.equal(report.totals.totalTokens, 27);
  assert.equal(report.totals.images, 1);
  assert.equal(report.models.length, 2);
  assert.equal(report.records[0].status, "success");
  assert.ok(report.records.every((r: any) => r.durationMs >= 0));
  assert.equal((await api(`/admin/keys/${bobKey.key.id}/usage`)).total, 0);
  await api(`/tasks/${t.id}`, alice, "DELETE");
  assert.equal(
    (await api(`/admin/keys/${aliceKey.key.id}/usage`)).total,
    2,
    "Deleting tasks must not erase accounting",
  );
});
test("failed calls, cancellation and tool fallback are counted once per attempt", async () => {
  mode = "error";
  const failed = await run(textId);
  await settled(failed.id);
  mode = "slow";
  const cancelled = await run(textId);
  await new Promise((r) => setTimeout(r, 50));
  await api(`/tasks/${cancelled.id}/stop`, alice, "POST", {});
  await settled(cancelled.id);
  mode = "fallback";
  const before = requests;
  const fallback = await run(textId);
  await settled(fallback.id);
  assert.equal(requests - before, 2);
  mode = "normal";
  const report = await api(`/admin/keys/${aliceKey.key.id}/usage`);
  assert.equal(report.total, 6);
  assert.equal(report.totals.failed, 2);
  assert.equal(report.totals.cancelled, 1);
  assert.equal(report.totals.success, 3);
  assert.equal(report.totals.running, 0);
  assert.equal(report.totals.unreported, 3);
});
test("usage filters, bounds, unknown units and pagination report honest values", async () => {
  const make = (i: number) =>
    store.withOwner(bobKey.key.id, () => {
      const id = usageStore.startModelRequest(
        textId,
        "text",
        "fixture-task",
        "message-" + i,
      );
      usageStore.finishModelRequest(id, "success", {});
    });
  for (let i = 0; i < 28; i++) make(i);
  const first = await api(`/admin/keys/${bobKey.key.id}/usage`),
    second = await api(`/admin/keys/${bobKey.key.id}/usage?page=2`);
  assert.equal(first.records.length, 25);
  assert.equal(second.records.length, 3);
  assert.equal(first.totals.inputTokens, null);
  assert.equal(first.totals.totalTokens, null);
  assert.equal(first.totals.unreported, 28);
  const image = await api(
    `/admin/keys/${aliceKey.key.id}/usage?modelId=${imageId}`,
  );
  assert.equal(image.total, 1);
  assert.equal(image.totals.images, 1);
  const failures = await api(
    `/admin/keys/${aliceKey.key.id}/usage?status=error`,
  );
  assert.equal(failures.total, 2);
  assert.equal(
    (
      await api(
        `/admin/keys/${aliceKey.key.id}/usage?from=2099-01-01T00:00:00Z`,
      )
    ).total,
    0,
  );
  for (const query of [
    "page=0",
    "page=wat",
    "status=unknown",
    "from=bad",
    "from=2027-01-01T00:00:00Z&to=2026-01-01T00:00:00Z",
  ])
    assert.equal(
      (await request(`/admin/keys/${aliceKey.key.id}/usage?${query}`)).status,
      400,
    );
  assert.equal((await request("/admin/keys/unknown/usage")).status, 404);
  assert.deepEqual(
    usageStore.normalizedUsage({
      inputTokens: NaN,
      outputTokens: -1,
      totalTokens: Infinity,
    }),
    { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
  );
});
test("rotating an old key invalidates its login and sessions while retaining ownership, grants and usage", async () => {
  const oldCookie = bob;
  const oldId = bobKey.key.id;
  const report = await api(`/admin/keys/${oldId}/usage`);
  const before = await api("/tasks", bob, "POST", {});
  const rotated = await api(`/admin/keys/${oldId}/rotate`, admin, "POST", {});
  assert.equal(rotated.key.id, oldId);
  assert.deepEqual(rotated.key.modelIds, [textId]);
  assert.notEqual(rotated.secret, bobKey.secret);
  assert.equal(
    (await request("/auth/login", "", "POST", { key: bobKey.secret })).status,
    401,
  );
  assert.equal((await request("/bootstrap", oldCookie)).status, 401);
  bob = await login(rotated.secret);
  assert.equal((await api(`/tasks/${before.id}`, bob)).id, before.id);
  assert.equal((await api(`/admin/keys/${oldId}/usage`)).total, report.total);
  assert.equal(
    (await api(`/admin/keys/${oldId}/secret`, admin, "POST", {})).secret,
    rotated.secret,
  );
  await api(`/admin/keys/${oldId}`, admin, "DELETE");
  assert.equal(
    store.db.prepare("SELECT 1 FROM access_key_secrets WHERE id=?").get(oldId),
    undefined,
  );
  assert.equal(
    (
      store.db
        .prepare("SELECT COUNT(*) AS n FROM model_requests WHERE key_id=?")
        .get(oldId) as any
    ).n,
    28,
  );
});

test("managed continuation steps count actual upstream calls and do not count tool execution as another model request", async () => {
  const before = await api(`/admin/keys/${aliceKey.key.id}/usage`),
    callsBefore = requests;
  mode = "steps";
  const task = await run(textId);
  await settled(task.id);
  mode = "normal";
  const after = await api(`/admin/keys/${aliceKey.key.id}/usage`);
  assert.equal(requests - callsBefore, 2);
  assert.equal(after.total - before.total, 2);
  assert.equal(after.totals.inputTokens - before.totals.inputTokens, 20);
  assert.equal(after.totals.outputTokens - before.totals.outputTokens, 10);
});

test("encrypted key recovery and usage persist across restart; unfinished records are marked interrupted", () => {
  const issued = store.withOwner(store.PLATFORM_OWNER, () =>
    keyStore.issueKey({
      label: "Persistence",
      modelIds: [textId],
      enabled: true,
    }),
  );
  const pending = store.withOwner(issued.key.id, () =>
    usageStore.startModelRequest(
      textId,
      "text",
      "fixture-task",
      "fixture-message",
    ),
  );
  const encrypted = (
    store.db
      .prepare("SELECT secret FROM access_key_secrets WHERE id=?")
      .get(issued.key.id) as any
  ).secret;
  const script = `import * as s from './server/store.ts';import * as k from './server/key-management.ts';await import('./server/usage.ts');import {createHash} from 'node:crypto';const id=process.env.TEST_KEY_ID;console.log(JSON.stringify({hash:s.withOwner(s.PLATFORM_OWNER,()=>createHash('sha256').update(k.revealKey(id)).digest('hex')),status:s.db.prepare('SELECT status FROM model_requests WHERE id=?').get(process.env.TEST_REQUEST_ID).status}));s.db.close();`;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_KEY_ID: issued.key.id,
          TEST_REQUEST_ID: pending,
        },
      },
    ),
  );
  assert.equal(result.hash, hash(issued.secret));
  assert.equal(result.status, "interrupted");
  assert.equal(
    (
      store.db
        .prepare("SELECT secret FROM access_key_secrets WHERE id=?")
        .get(issued.key.id) as any
    ).secret,
    encrypted,
  );
});
