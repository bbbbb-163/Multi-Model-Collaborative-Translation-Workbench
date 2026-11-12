import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKBENCH_DATA = mkdtempSync(join(tmpdir(), "mstar-audit-"));
process.env.WORKBENCH_MAX_STORAGE_MB = "2";
process.env.WORKBENCH_MAX_RUNS_PER_OWNER = "2";
process.env.WORKBENCH_MAX_TOTAL_RUNS = "4";
let server: Server, upstream: Server, base: string, upstreamUrl: string;
let admin: string, user: string, secret: string, catalog: any, provider: any;
let mode: "text" | "echo" | "artifact" | "slow" = "text";
const key = "upstream-private-secret-that-must-never-stream-1234";
async function request(
  path: string,
  cookie = user,
  method = "GET",
  body?: any,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      Cookie: cookie || "",
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
}
async function api(path: string, cookie = user, method = "GET", body?: any) {
  const res = await request(path, cookie, method, body),
    data = await res.json();
  assert.ok(res.ok, `${path}: ${JSON.stringify(data)}`);
  return data;
}
async function task() {
  const t = await api("/tasks", user, "POST", {});
  return api(`/tasks/${t.id}`, user, "PATCH", {
    settings: {
      ...t.settings,
      selections: [{ providerId: catalog.id, modelId: catalog.id, role: "" }],
      capability: "text",
    },
  });
}
async function done(id: string) {
  for (let i = 0; i < 150; i++) {
    const t = await api(`/tasks/${id}`);
    if (!t.running) return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run timeout");
}
before(async () => {
  upstream = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    const json = (value: any) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (req.url === "/v1/models") {
      json({ data: [{ id: "secret-text-model", capabilities: ["text"] }] });
      return;
    }
    if (!body.stream) {
      json({
        id: "t",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    const emit = (delta: any, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (mode === "slow") await new Promise((r) => setTimeout(r, 600));
    if (
      mode === "artifact" &&
      !body.messages.some((m: any) => m.role === "tool")
    ) {
      emit(
        {
          tool_calls: [
            {
              index: 0,
              id: "save",
              type: "function",
              function: {
                name: "save_file",
                arguments: JSON.stringify({
                  name: "secret-text-model.txt",
                  content: `${key}\n${upstreamUrl}\nsecret-text-model`,
                  mime: "application/not-json",
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
    } else if (mode === "echo") {
      emit({ content: `结果：${key.slice(0, -2)}` });
      await new Promise((r) => setTimeout(r, 130));
      emit({ content: key.slice(-2) });
      emit({}, "stop");
    } else {
      emit({ content: "完成" });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
  const { createApp } = await import("../server/app.ts");
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const { setupCode } = await import("../server/auth.ts");
  const setup = await request("/auth/setup", "", "POST", {
    code: setupCode(),
    password: "audit-admin-password-long",
  });
  assert.equal(setup.status, 200);
  admin = setup.headers.get("set-cookie")!.split(";")[0];
  provider = await api("/admin/providers", admin, "POST", {
    url: upstreamUrl,
    key,
  });
  catalog = await api("/admin/models", admin, "POST", {
    providerId: provider.id,
    modelId: "secret-text-model",
    name: "文字助手",
    capabilities: ["text"],
  });
  await api(`/admin/models/${catalog.id}/test`, admin, "POST", {
    capability: "text",
  });
  await api(`/admin/models/${catalog.id}`, admin, "PATCH", { published: true });
  const issued = await api("/admin/keys", admin, "POST", {
    label: "Audit user",
    modelIds: [catalog.id],
  });
  secret = issued.secret;
  const login = await request("/auth/login", "", "POST", { key: secret });
  user = login.headers.get("set-cookie")!.split(";")[0];
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  upstream?.closeAllConnections();
  upstream?.close();
});

test("admin route variants cannot bypass authentication or alter global grants", async () => {
  for (const prefix of ["/Admin", "/ADMIN", "/aDmIn"]) {
    assert.equal((await request(`${prefix}/bootstrap`)).status, 401, prefix);
    assert.equal(
      (
        await request(`${prefix}/keys`, user, "POST", {
          label: "forged",
          modelIds: [catalog.id],
        })
      ).status,
      401,
      prefix,
    );
  }
  const upper = await fetch(
    `${base.replace(/\/api$/, "/API")}/ADMIN/bootstrap`,
    { headers: { Cookie: user } },
  );
  assert.equal(upper.status, 401);
  assert.equal(upper.headers.get("cache-control"), "no-store");
});
test("custom capability labels come only from granted model connections", async () => {
  const store = await import("../server/store.ts");
  const identity = await api("/auth/status");
  store.withOwner(store.PLATFORM_OWNER, () => {
    for (const [id, label] of [
      ["public-custom", "公开能力"],
      ["private-custom", "未授权的内部能力"],
    ])
      store.putProvider(
        {
          ...provider,
          id,
          customCapabilities: [
            { id: "shared-cap", label, path: "/generate", output: "text" },
          ],
        },
        key,
      );
    const id = "mstar_custom-audit";
    store.putCatalogModel({
      id,
      providerId: "public-custom",
      modelId: "secret-text-model",
      name: "已授权扩展模型",
      capabilities: ["shared-cap"],
      published: true,
      testedCapabilities: ["shared-cap"],
      createdAt: store.now(),
    });
    const k = store.accessKey(identity.user.id)!;
    store.putAccessKey({ ...k, modelIds: [...k.modelIds, id] });
  });
  const boot = await api("/bootstrap");
  assert.ok(
    boot.capabilities.some(
      (c: any) => c.id === "shared-cap" && c.label === "公开能力",
    ),
  );
  assert.ok(!JSON.stringify(boot).includes("未授权的内部能力"));
});
test("discovery JSON body limits apply even when content-length is absent", async () => {
  const { limitedJson } = await import("../server/network.ts");
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(() => limitedJson(new Response(body)), /返回数据过大/);
  assert.equal(cancelled, true);
  assert.deepEqual(await limitedJson(new Response('{"data":[]}')), {
    data: [],
  });
});
test("JSON redaction preserves syntax for quoted model aliases and unusual MIME casing", async () => {
  const { managedFileData } = await import("../server/providers.ts");
  const p = {
    ...provider,
    managed: true as const,
    upstreamModelId: "secret-text-model",
    name: '文字 "高级"',
  };
  const data = managedFileData(
    p,
    "APPLICATION/JSON",
    Buffer.from(
      JSON.stringify({ model: "secret-text-model", credential: key }),
    ),
    key,
  );
  const parsed = JSON.parse(Buffer.from(data).toString());
  assert.equal(parsed.model, p.name);
  assert.ok(!parsed.credential.includes(key));
});
test("proxy configuration cannot bypass actual Host validation", async () => {
  const previous = process.env.WORKBENCH_TRUST_PROXY;
  process.env.WORKBENCH_TRUST_PROXY = "loopback";
  const { createApp } = await import("../server/app.ts");
  const other = createApp().listen(0, "127.0.0.1");
  await once(other, "listening");
  try {
    const status = await new Promise<number>((resolve, reject) =>
      httpRequest(
        `http://127.0.0.1:${(other.address() as any).port}/api/health`,
        { headers: { Host: "evil.example", "X-Forwarded-Host": "localhost" } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      )
        .on("error", reject)
        .end(),
    );
    assert.equal(status, 403);
  } finally {
    other.closeAllConnections();
    other.close();
    if (previous === undefined) delete process.env.WORKBENCH_TRUST_PROXY;
    else process.env.WORKBENCH_TRUST_PROXY = previous;
  }
});
test("missing owner context fails closed instead of selecting administrator data", async () => {
  const store = await import("../server/store.ts");
  assert.throws(() => store.tasks(), /身份|上下文/);
  assert.throws(() => store.providers(), /身份|上下文/);
  assert.throws(
    () => store.saveFile("orphan.txt", "text/plain", Buffer.from("x")),
    /身份|上下文/,
  );
});
test("streaming output never publishes a partial upstream secret", async () => {
  mode = "echo";
  const t = await task(),
    ctrl = new AbortController();
  const stream = await request(`/tasks/${t.id}/events`, user);
  const reader = stream.body!.getReader();
  let output = "";
  const reading = (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        output += Buffer.from(result.value).toString();
      }
    } catch {}
  })();
  await api(`/tasks/${t.id}/run`, user, "POST", { content: "echo" });
  await done(t.id);
  await reader.cancel();
  await reading;
  ctrl.abort();
  assert.ok(
    !output.includes(key.slice(0, -2)),
    "流式中间消息也必须隐藏凭据前缀",
  );
});
test("model-created text files redact managed credentials, URL and actual model id", async () => {
  mode = "artifact";
  const t = await task();
  await api(`/tasks/${t.id}/run`, user, "POST", { content: "save file" });
  const result = await done(t.id),
    file = result.messages.flatMap((m: any) => m.attachments)[0];
  assert.ok(file);
  const content = await (await request(file.url.replace(/^\/api/, ""))).text();
  for (const value of [key, upstreamUrl, "secret-text-model"])
    assert.ok(!content.includes(value), value);
  assert.ok(!file.name.includes("secret-text-model"));
});
test("storage quota rejects extra bytes before writing an orphan file", async () => {
  const store = await import("../server/store.ts"),
    before = readdirSync(store.filesDir).length;
  assert.throws(
    () =>
      store.withOwner("quota-user", () =>
        store.saveFile(
          "large.bin",
          "application/octet-stream",
          Buffer.alloc(3 * 1024 * 1024),
        ),
      ),
    /存储|空间/,
  );
  assert.equal(readdirSync(store.filesDir).length, before);
});
test("rejected multipart uploads clean temporary files and expose no active HTML", async () => {
  const store = await import("../server/store.ts");
  const before = readdirSync(store.filesDir).length;
  const body = new FormData();
  body.append("files", new Blob([Buffer.alloc(3 * 1024 * 1024)]), "large.bin");
  assert.equal((await request("/files", user, "POST", body)).status, 413);
  assert.deepEqual(readdirSync(join(store.dataDir, "uploads-tmp")), []);
  assert.equal(readdirSync(store.filesDir).length, before);
  const html = new FormData();
  html.append(
    "files",
    new Blob(["<script>window.xss=true</script>"], { type: "text/html" }),
    "page.html",
  );
  const [file] = await api("/files", user, "POST", html);
  const download = await request(file.url.replace(/^\/api/, ""));
  assert.match(
    download.headers.get("content-type")!,
    /application\/octet-stream/,
  );
  assert.match(download.headers.get("content-disposition")!, /attachment/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
});
test("parallel tasks are bounded per owner without changing collaboration round behavior", async () => {
  mode = "slow";
  const tasks = await Promise.all([task(), task(), task()]);
  await api(`/tasks/${tasks[0].id}/run`, user, "POST", { content: "slow" });
  await api(`/tasks/${tasks[1].id}/run`, user, "POST", { content: "slow" });
  assert.equal(
    (
      await request(`/tasks/${tasks[2].id}/run`, user, "POST", {
        content: "slow",
      })
    ).status,
    429,
  );
  await Promise.all(tasks.slice(0, 2).map((t) => done(t.id)));
});
test("successful logins do not lock users out and user failures cannot lock administrator login", async () => {
  for (let i = 0; i < 32; i++)
    assert.equal(
      (await request("/auth/login", "", "POST", { key: secret })).status,
      200,
    );
  for (let i = 0; i < 30; i++)
    assert.equal(
      (await request("/auth/login", "", "POST", { key: "invalid" })).status,
      401,
    );
  assert.equal(
    (await request("/auth/login", "", "POST", { key: "invalid" })).status,
    429,
  );
  const spoofed = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": "8.8.8.8",
    },
    body: JSON.stringify({ key: "invalid" }),
  });
  assert.equal(spoofed.status, 429, "未配置可信代理时不能用转发头绕过限流");
  assert.equal(
    (
      await request("/auth/admin", "", "POST", {
        password: "audit-admin-password-long",
      })
    ).status,
    200,
  );
});
