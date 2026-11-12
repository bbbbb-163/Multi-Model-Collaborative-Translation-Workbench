import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.WORKBENCH_DATA = mkdtempSync(join(tmpdir(), "mstar-security-"));
let server: Server,
  upstream: Server,
  base: string,
  upstreamUrl: string,
  admin: string,
  alice: string,
  bob: string;
let p: any,
  text: any,
  image: any,
  video: any,
  aliceKey: any,
  bobKey: any,
  aliceTask: any;
const upstreamKey = "private-upstream-secret-do-not-publish-1234";
const calls: { path: string; body: any; auth?: string }[] = [];
let fail = false,
  slow = false;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=";
async function request(path: string, cookie = "", method = "GET", body?: any) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      Cookie: cookie,
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
}
async function api(path: string, cookie = admin, method = "GET", body?: any) {
  const r = await request(path, cookie, method, body),
    value = await r.json();
  assert.ok(r.ok, `${path}: ${JSON.stringify(value)}`);
  return value;
}
async function login(secret: string) {
  const r = await request("/auth/login", "", "POST", { key: secret });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
async function settled(id: string, cookie = alice) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const t = await api(`/tasks/${id}`, cookie);
    if (!t.running) return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Run did not finish");
}
async function taskFor(model: any, cookie = alice) {
  const t = await api("/tasks", cookie, "POST", {});
  return api(`/tasks/${t.id}`, cookie, "PATCH", {
    settings: {
      ...t.settings,
      selections: [{ providerId: model.id, modelId: model.id, role: "" }],
      primary: `${model.id}::${model.id}`,
      capability: model.capabilities[0],
    },
  });
}
before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    calls.push({ path: req.url!, body, auth: req.headers.authorization });
    const json = (v: any) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (req.headers.authorization !== `Bearer ${upstreamKey}`) {
      res.statusCode = 401;
      json({ error: { message: "invalid key" } });
      return;
    }
    if (req.url === "/v1/models") {
      json({
        data: [
          { id: "private-text-engine-xx", capabilities: ["text"] },
          { id: "private-image-engine-yy", capabilities: ["image"] },
          { id: "private-video-engine-zz", capabilities: ["video"] },
        ],
      });
      return;
    }
    if (req.url === "/v1/chat/completions") {
      if (fail) {
        res.statusCode = 403;
        json({
          error: {
            message: `private-text-engine-xx ${upstreamUrl} ${upstreamKey} internal-request-123`,
          },
        });
        return;
      }
      if (slow) await new Promise((r) => setTimeout(r, 500));
      if (!body.stream) {
        json({
          id: "test",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "测试连接成功" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        });
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        `data: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta: { content: "模型的实际响应" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (req.url === "/v1/images/generations") {
      json({ data: [{ b64_json: png }] });
      return;
    }
    if (req.url === "/v1/videos") {
      json({ id: "private-job-123", status: "completed" });
      return;
    }
    if (req.url === "/v1/videos/private-job-123/content") {
      res.setHeader("Content-Type", "video/mp4");
      res.end("fixture-video");
      return;
    }
    res.statusCode = 404;
    json({ error: { message: "not found" } });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
  const { createApp } = await import("../server/app.ts");
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  upstream?.closeAllConnections();
  upstream?.close();
});

test("no anonymous workspace, setup requires a local one-time code, admin password creates HttpOnly session", async () => {
  assert.equal((await request("/bootstrap")).status, 401);
  assert.equal(
    (
      await request("/auth/setup", "", "POST", {
        code: "wrong",
        password: "a-long-password-for-admin",
      })
    ).status,
    403,
  );
  const { setupCode } = await import("../server/auth.ts");
  const r = await request("/auth/setup", "", "POST", {
    code: setupCode(),
    password: "a-long-password-for-admin",
  });
  assert.equal(r.status, 200);
  const c = r.headers.get("set-cookie")!;
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  admin = c.split(";")[0];
  const status = await api("/auth/status", admin);
  assert.equal(status.admin, true);
  assert.equal(status.user, null, "后台登录不能自动创建工作台身份");
  assert.equal((await request("/bootstrap", admin)).status, 401);
  assert.equal(
    (
      await request("/auth/setup", "", "POST", {
        code: "wrong",
        password: "a-long-password-for-admin",
      })
    ).status,
    403,
  );
});
test("administrator adds URL + upstream key, publishes only after real per-capability tests", async () => {
  p = await api("/admin/providers", admin, "POST", {
    url: upstreamUrl,
    key: upstreamKey,
  });
  assert.equal(p.models.length, 3);
  assert.ok(!JSON.stringify(p).includes(upstreamKey));
  const add = (modelId: string, name: string, capability: string) =>
    api("/admin/models", admin, "POST", {
      providerId: p.id,
      modelId,
      name,
      capabilities: [capability],
    });
  text = await add(p.models[0].id, "文字助手", "text");
  image = await add(p.models[1].id, "图片生成", "image");
  video = await add(p.models[2].id, "视频生成", "video");
  assert.equal(
    (
      await request(`/admin/models/${text.id}`, admin, "PATCH", {
        published: true,
      })
    ).status,
    400,
  );
  for (const m of [text, image, video]) {
    const result = await api(`/admin/models/${m.id}/test`, admin, "POST", {
      capability: m.capabilities[0],
    });
    assert.ok(result.model.testedCapabilities.includes(m.capabilities[0]));
    await api(`/admin/models/${m.id}`, admin, "PATCH", { published: true });
  }
});
test("distributor credentials stay out of metadata, keep hashed authentication and require admin recovery", async () => {
  aliceKey = await api("/admin/keys", admin, "POST", {
    label: "Alice",
    modelIds: [text.id, image.id],
  });
  bobKey = await api("/admin/keys", admin, "POST", {
    label: "Bob",
    modelIds: [video.id],
  });
  assert.notEqual(aliceKey.secret, upstreamKey);
  alice = await login(aliceKey.secret);
  bob = await login(bobKey.secret);
  const metadata = JSON.stringify(await api("/admin/bootstrap"));
  assert.ok(!metadata.includes(aliceKey.secret));
  assert.ok(!metadata.includes(bobKey.secret));
  const { db } = await import("../server/store.ts");
  assert.ok(
    !JSON.stringify(db.prepare("SELECT * FROM access_keys").all()).includes(
      aliceKey.secret,
    ),
  );
  assert.ok(
    !JSON.stringify(db.prepare("SELECT * FROM sessions").all()).includes(
      alice.split("=")[1],
    ),
  );
  assert.equal(
    (await request("/auth/login", "", "POST", { key: upstreamKey })).status,
    401,
  );
});
test("Mstar catalog exposes only granted aliases and capabilities, and no upstream configuration", async () => {
  const a = await api("/bootstrap", alice),
    b = await api("/bootstrap", bob);
  assert.deepEqual(
    a.providers.map((p: any) => p.name),
    ["文字助手", "图片生成"],
  );
  assert.deepEqual(
    b.providers.map((p: any) => p.name),
    ["视频生成"],
  );
  for (const json of [JSON.stringify(a), JSON.stringify(b)]) {
    for (const hidden of [
      upstreamUrl,
      upstreamKey,
      p.id,
      "private-text-engine-xx",
      "private-image-engine-yy",
      "private-video-engine-zz",
      "keyHint",
      "custom-secret-path",
    ])
      assert.ok(!json.includes(hidden), hidden);
  }
  assert.equal((await request("/admin/bootstrap", alice)).status, 401);
  assert.equal(
    (
      await request(`/admin/models/${text.id}`, bob, "PATCH", {
        published: false,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(`/providers/${text.id}`, alice, "PATCH", {
        url: upstreamUrl,
      })
    ).status,
    404,
  );
});
test("simultaneous admin/user sessions log out independently without falling back to administrator", async () => {
  const userCookie = await login(aliceKey.secret);
  const combined = `${admin}; ${userCookie}`;
  assert.equal((await api("/auth/status", combined)).user.id, aliceKey.key.id);
  await api("/auth/logout", combined, "POST", { admin: false });
  const afterUserLogout = await api("/auth/status", combined);
  assert.equal(afterUserLogout.user, null);
  assert.equal(afterUserLogout.admin, true);
  assert.equal((await request("/bootstrap", combined)).status, 401);
  assert.equal((await request("/admin/bootstrap", combined)).status, 200);
  const adminLogin = await request("/auth/admin", "", "POST", {
    password: "a-long-password-for-admin",
  });
  assert.equal(adminLogin.status, 200);
  const otherAdminCookie = adminLogin.headers.get("set-cookie")!.split(";")[0];
  const both = `${otherAdminCookie}; ${alice}`;
  await api("/auth/logout", both, "POST", { admin: true });
  const afterAdminLogout = await api("/auth/status", both);
  assert.equal(afterAdminLogout.admin, false);
  assert.equal(afterAdminLogout.user.id, aliceKey.key.id);
  assert.equal((await request("/bootstrap", both)).status, 200);
  assert.equal((await request("/admin/bootstrap", both)).status, 401);
});
test("legacy administrator workspace requires explicit entry and never replaces a logged-in user", async () => {
  assert.equal(
    (await request("/auth/admin-workspace", alice, "POST", {})).status,
    401,
  );
  assert.equal(
    (await request("/auth/admin-workspace", `${admin}; ${alice}`, "POST", {}))
      .status,
    409,
  );
  const preview = await request("/auth/admin-workspace", admin, "POST", {});
  assert.equal(preview.status, 200);
  const workspaceCookie = preview.headers.get("set-cookie")!.split(";")[0];
  const combined = `${admin}; ${workspaceCookie}`;
  assert.equal((await api("/auth/status", combined)).user.role, "admin");
  assert.equal((await request("/bootstrap", combined)).status, 200);
  assert.equal(
    (await request("/admin/bootstrap", workspaceCookie)).status,
    401,
  );
  await api("/auth/logout", combined, "POST", { admin: false });
  const status = await api("/auth/status", combined);
  assert.equal(status.user, null);
  assert.equal(status.admin, true);
});
test("tasks, files, event subscriptions, exports, mutations and stops are isolated between issued keys", async () => {
  aliceTask = await taskFor(text);
  const fileBody = new FormData();
  fileBody.append("files", new Blob(["alice-private-file"]), "alice.txt");
  const files = await api("/files", alice, "POST", fileBody);
  for (const path of [
    `/tasks/${aliceTask.id}`,
    `/tasks/${aliceTask.id}/events`,
    `/tasks/${aliceTask.id}/export?format=json`,
    `/files/${files[0].id}`,
  ])
    assert.equal((await request(path, bob)).status, 404, path);
  for (const [path, method, body] of [
    [`/tasks/${aliceTask.id}`, "PATCH", { title: "stolen" }],
    [`/tasks/${aliceTask.id}`, "DELETE", undefined],
    [`/tasks/${aliceTask.id}/stop`, "POST", {}],
  ] as const)
    assert.equal((await request(path, bob, method, body)).status, 404);
  const bt = await taskFor(video, bob);
  assert.equal(
    (
      await request(`/tasks/${bt.id}/run`, bob, "POST", {
        content: "use file",
        attachments: [files[0].id],
      })
    ).status,
    400,
  );
  assert.equal(
    (await api("/bootstrap", bob)).tasks.some(
      (t: any) => t.id === aliceTask.id,
    ),
    false,
  );
});
test("forged selection cannot call an ungranted model or real upstream provider/model", async () => {
  const t = await api("/tasks", alice, "POST", {});
  for (const s of [
    { providerId: video.id, modelId: video.id, role: "" },
    { providerId: p.id, modelId: p.models[0].id, role: "" },
    { providerId: text.id, modelId: p.models[0].id, role: "" },
  ])
    assert.equal(
      (
        await request(`/tasks/${t.id}`, alice, "PATCH", {
          settings: { ...t.settings, selections: [s] },
        })
      ).status,
      400,
    );
});
test("real Mstar invocation maps alias to upstream server-side, with public model names and local media", async () => {
  await api(`/tasks/${aliceTask.id}/run`, alice, "POST", { content: "hello" });
  const t = await settled(aliceTask.id);
  assert.ok(
    t.messages.some(
      (m: any) => m.model === "文字助手" && m.content === "模型的实际响应",
    ),
  );
  const upstreamRequest = calls
    .filter((c) => c.path === "/v1/chat/completions")
    .at(-1)!;
  assert.equal(upstreamRequest.body.model, p.models[0].id);
  assert.equal(upstreamRequest.auth, `Bearer ${upstreamKey}`);
  const im = await taskFor(image);
  await api(`/tasks/${im.id}/run`, alice, "POST", { content: "a tree" });
  const generated = (await settled(im.id)).messages.flatMap(
    (m: any) => m.attachments,
  )[0];
  assert.match(generated.name, /^图片生成/);
  assert.equal((await requestFetch(generated.url, alice)).status, 200);
  assert.equal((await requestFetch(generated.url, bob)).status, 404);
  const exportText = await (
    await request(`/tasks/${im.id}/export?format=json`, alice)
  ).text();
  assert.ok(!exportText.includes("private-image-engine-yy"));
  assert.ok(!exportText.includes(upstreamUrl));
});
const requestFetch = (url: string, cookie: string) =>
  request(url.replace(/^\/api/, ""), cookie);
test("Mstar members reuse ordered workflow execution without exposing upstream model identifiers", async () => {
  const t = await api("/tasks", alice, "POST", {});
  await api(`/tasks/${t.id}`, alice, "PATCH", {
    settings: {
      ...t.settings,
      mode: "workflow",
      selections: [text, image].map((m) => ({
        providerId: m.id,
        modelId: m.id,
        role: "",
      })),
      workflow: [text, image].map((m, i) => ({
        id: `step-${i}`,
        providerId: m.id,
        modelId: m.id,
        capability: m.capabilities[0],
        prompt: "",
        inputSource: "previous",
        optionsJson: "",
      })),
    },
  });
  await api(`/tasks/${t.id}/run`, alice, "POST", {
    content: "先写一句话，再生成图片",
  });
  const result = await settled(t.id);
  assert.ok(
    result.messages.some(
      (m: any) => m.model === "文字助手" && m.status === "done",
    ),
  );
  assert.ok(
    result.messages.some(
      (m: any) => m.model === "图片生成" && m.attachments.length,
    ),
  );
  assert.ok(!JSON.stringify(result).includes("private-text-engine-xx"));
  assert.ok(!JSON.stringify(result).includes("private-image-engine-yy"));
});
test("upstream failures never disclose key, address, request id or actual model through messages and export", async () => {
  fail = true;
  await api(`/tasks/${aliceTask.id}/run`, alice, "POST", { content: "fail" });
  const t = await settled(aliceTask.id);
  fail = false;
  const output = JSON.stringify(t);
  assert.match(output, /Mstar 模型暂时无法完成请求/);
  for (const hidden of [
    upstreamKey,
    upstreamUrl,
    "private-text-engine-xx",
    "internal-request-123",
  ])
    assert.ok(!output.includes(hidden));
});
test("self-connected models cannot access local/metadata addresses; address policy rejects mapped IPv6", async () => {
  const count = calls.length;
  const r = await request("/providers", alice, "POST", {
    url: upstreamUrl,
    key: "attacker",
  });
  assert.equal(r.status, 400);
  assert.equal(calls.length, count);
  for (const url of [
    "http://169.254.169.254/latest",
    "http://[::ffff:127.0.0.1]",
    "http://127.1",
    "http://localhost:3210",
  ])
    assert.equal(
      (await request("/providers/discover", alice, "POST", { url })).status,
      400,
    );
  const { publicAddress } = await import("../server/network.ts");
  assert.equal(publicAddress("::ffff:127.0.0.1"), false);
  assert.equal(publicAddress("10.0.0.1"), false);
  assert.equal(publicAddress("8.8.8.8"), true);
});
test("revoking a model grant cancels active runs, removes visibility and rejects saved tasks", async () => {
  slow = true;
  await api(`/tasks/${aliceTask.id}/run`, alice, "POST", { content: "slow" });
  await api(`/admin/keys/${aliceKey.key.id}`, admin, "PATCH", {
    modelIds: [image.id],
  });
  await settled(aliceTask.id);
  slow = false;
  assert.deepEqual(
    (await api("/bootstrap", alice)).providers.map((p: any) => p.id),
    [image.id],
  );
  assert.equal(
    (
      await request(`/tasks/${aliceTask.id}/run`, alice, "POST", {
        content: "replay",
      })
    ).status,
    400,
  );
  await api(`/admin/keys/${aliceKey.key.id}`, admin, "PATCH", {
    modelIds: [text.id, image.id],
  });
});
test("Mstar rejects forged interface overrides before making an upstream call", async () => {
  const count = calls.length;
  await api(`/tasks/${aliceTask.id}/run`, alice, "POST", {
    content: "override",
    options: { model: "private-video-engine-zz", baseURL: "http://127.0.0.1" },
  });
  const t = await settled(aliceTask.id);
  assert.ok(t.messages.some((m: any) => m.status === "error"));
  assert.equal(calls.length, count);
});
test("expired keys cannot log in and expiry changes affect already established sessions", async () => {
  const issued = await api("/admin/keys", admin, "POST", {
    label: "Expiring",
    modelIds: [text.id],
  });
  const cookie = await login(issued.secret);
  await api(`/admin/keys/${issued.key.id}`, admin, "PATCH", {
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal((await request("/bootstrap", cookie)).status, 401);
  const combined = `${admin}; ${cookie}`;
  assert.equal((await api("/auth/status", combined)).user, null);
  assert.equal((await request("/bootstrap", combined)).status, 401);
  assert.equal(
    (await request("/auth/login", "", "POST", { key: issued.secret })).status,
    401,
  );
  await api(`/admin/keys/${issued.key.id}`, admin, "PATCH", {
    expiresAt: null,
  });
  assert.ok(await login(issued.secret));
});
test("all enabled capabilities must pass tests, failed testing unpublishes and unavailable members remain removable", async () => {
  await api(`/admin/providers/${p.id}`, admin, "PATCH", {
    models: p.models.map((m: any, index: number) =>
      index === 0 ? { ...m, capabilities: ["text", "image"] } : m,
    ),
  });
  const dual = await api("/admin/models", admin, "POST", {
    providerId: p.id,
    modelId: p.models[0].id,
    name: "多能力",
    capabilities: ["text", "image"],
  });
  await api(`/admin/models/${dual.id}/test`, admin, "POST", {
    capability: "text",
  });
  assert.equal(
    (
      await request(`/admin/models/${dual.id}`, admin, "PATCH", {
        published: true,
      })
    ).status,
    400,
  );
  await api(`/admin/models/${dual.id}/test`, admin, "POST", {
    capability: "image",
  });
  await api(`/admin/models/${dual.id}`, admin, "PATCH", { published: true });
  fail = true;
  assert.equal(
    (
      await request(`/admin/models/${dual.id}/test`, admin, "POST", {
        capability: "text",
      })
    ).status,
    400,
  );
  fail = false;
  const state = (await api("/admin/bootstrap")).models.find(
    (m: any) => m.id === dual.id,
  );
  assert.equal(state.published, false);
  const old = await api(`/tasks/${aliceTask.id}`, alice);
  const removed = await api(`/tasks/${old.id}`, alice, "PATCH", {
    settings: { ...old.settings, selections: [] },
  });
  assert.equal(removed.settings.selections.length, 0);
});
test("upstream edits invalidate tests and unpublish affected models, and disabling keys invalidates sessions", async () => {
  await api(`/admin/providers/${p.id}`, admin, "PATCH", { key: upstreamKey });
  assert.equal((await api("/bootstrap", alice)).providers.length, 0);
  assert.equal(
    (
      await request(`/admin/models/${text.id}`, admin, "PATCH", {
        published: true,
      })
    ).status,
    400,
  );
  await api(`/admin/keys/${aliceKey.key.id}`, admin, "PATCH", {
    enabled: false,
  });
  assert.equal((await request("/bootstrap", alice)).status, 401);
  assert.equal((await api("/auth/status", `${admin}; ${alice}`)).user, null);
  assert.equal(
    (await request("/auth/login", "", "POST", { key: aliceKey.secret })).status,
    401,
  );
  assert.equal((await request("/bootstrap", bob)).status, 200);
  const { dataDir } = await import("../server/store.ts");
  assert.ok(
    !readFileSync(join(dataDir, "workbench.sqlite")).includes(
      Buffer.from(upstreamKey),
    ),
  );
});
