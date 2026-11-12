import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// Match production: attachments live below a dot-prefixed .data directory.
const temp = join(
  mkdtempSync(join(tmpdir(), "model-workbench-test-")),
  ".data",
);
process.env.WORKBENCH_DATA = temp;
let app: Server, upstream: Server, base: string, upstreamUrl: string;
let adminCookie = "";
const fetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  if (base && String(input).startsWith(base) && adminCookie)
    headers.set("Cookie", adminCookie);
  return globalThis.fetch(input, { ...init, headers });
};
let provider: any;
const requests: any[] = [];
let concurrent = 0,
  maxConcurrent = 0;
const key = "test-secret-do-not-return-12345678";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=";
before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks).toString();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    requests.push({
      path: req.url,
      method: req.method,
      body,
      auth: req.headers.authorization,
    });
    const json = (value: any) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (req.url === "/v1/models") {
      if (req.headers.authorization === "Bearer bad-key") {
        res.statusCode = 401;
        json({ error: { message: "Invalid API key bad-key" } });
        return;
      }
      json({
        data: [
          { id: "worker-a", capabilities: ["text"] },
          { id: "worker-b", capabilities: ["text"] },
          { id: "image-model", capabilities: ["image"] },
          { id: "video-model", capabilities: ["video"] },
          { id: "speech-model", capabilities: ["speech"] },
          { id: "transcribe-model", capabilities: ["transcription"] },
          { id: "embed-model", capabilities: ["embedding"] },
        ],
      });
      return;
    }
    if (req.url === "/v1/chat/completions") {
      if (
        body.model === "worker-b" &&
        JSON.stringify(body.messages).includes("one-member-fails")
      ) {
        res.statusCode = 404;
        json({ error: { message: "model deployment not found" } });
        return;
      }
      if (
        JSON.stringify(body.messages).includes("plain-model-without-tools") &&
        body.tools?.length
      ) {
        res.statusCode = 400;
        json({ error: { message: "This model does not support tools" } });
        return;
      }
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      res.on("close", () => concurrent--);
      res.setHeader("Content-Type", "text/event-stream");
      res.flushHeaders();
      const sse = (delta: any, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      const last = body.messages.at(-1);
      const lastContent =
        typeof last.content === "string"
          ? last.content
          : JSON.stringify(last.content);
      if (lastContent.includes("slow-request")) {
        const timer = setTimeout(() => {
          sse({ content: "太迟了" }, "stop");
          res.end("data: [DONE]\n\n");
        }, 20000);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      await new Promise((r) => setTimeout(r, 80));
      if (
        last.role !== "tool" &&
        lastContent.includes("tool-image") &&
        body.model === "worker-a" &&
        !lastContent.includes("根据团队已经完成")
      ) {
        const system = body.messages.find(
          (m: any) => m.role === "system",
        ).content;
        const roster = JSON.parse(system.match(/团队名册：(.*)\n/)[1]);
        const target = roster.find((m: any) =>
          m.capabilities.includes("image"),
        ).ref;
        sse({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-image",
              type: "function",
              function: {
                name: "invoke_model",
                arguments: JSON.stringify({
                  target,
                  capability: "image",
                  prompt: "画一张图片",
                  optionsJson: lastContent.includes("options-object")
                    ? { size: "1024x1024" }
                    : lastContent.includes("options-string")
                      ? '{"size":"1024x1024"}'
                      : undefined,
                }),
              },
            },
            {
              index: 1,
              id: "call-save",
              type: "function",
              function: {
                name: "save_file",
                arguments: JSON.stringify({
                  name: "hello.py",
                  content: 'print("hello")',
                }),
              },
            },
          ],
        });
        sse({}, "tool_calls");
      } else if (
        last.role !== "tool" &&
        lastContent.includes("call-peer") &&
        body.model === "worker-a" &&
        !lastContent.includes("根据团队已经完成")
      ) {
        const roster = JSON.parse(
          body.messages[0].content.match(/团队名册：(.*)\n/)[1],
        );
        sse({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-peer",
              type: "function",
              function: {
                name: "invoke_model",
                arguments: JSON.stringify({
                  target: roster.find((r: any) => r.model === "worker-b").ref,
                  capability: "text",
                  prompt: "SUBTASK 请审阅结果",
                }),
              },
            },
          ],
        });
        sse({}, "tool_calls");
      } else {
        sse({ role: "assistant", content: "真实流式" });
        await new Promise((r) => setTimeout(r, 20));
        sse({ content: `响应 ${body.model}` });
        sse({}, "stop");
      }
      res.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    if (
      req.url === "/v1/images/generations" ||
      req.url === "/v1/images/edits"
    ) {
      json({ data: [{ b64_json: png }] });
      return;
    }
    if (req.url === "/v1/audio/speech") {
      res.setHeader("Content-Type", "audio/mpeg");
      res.end(Buffer.from("audio-fixture"));
      return;
    }
    if (req.url === "/v1/audio/transcriptions") {
      json({ text: "音频转写测试结果" });
      return;
    }
    if (req.url === "/v1/embeddings") {
      json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      return;
    }
    if (req.url === "/v1/videos" && req.method === "POST") {
      json({ id: "video-1", status: "completed" });
      return;
    }
    if (req.url === "/v1/videos/video-1/content") {
      res.setHeader("Content-Type", "video/mp4");
      res.end(Buffer.from("video-fixture"));
      return;
    }
    if (req.url === "/v1/custom") {
      json({ output: `自定义能力：${body.prompt}` });
      return;
    }
    res.statusCode = 404;
    json({ error: { message: "route not found" } });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
  const { createApp } = await import("../server/app.ts");
  app = createApp().listen(0, "127.0.0.1");
  await once(app, "listening");
  base = `http://127.0.0.1:${(app.address() as any).port}/api`;
  const { setupCode } = await import("../server/auth.ts");
  const login = await fetch(`${base}/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: setupCode(),
      password: "integration-admin-password",
    }),
  });
  assert.equal(login.status, 200);
  adminCookie = login.headers.get("set-cookie")!.split(";")[0];
  const workspace = await fetch(`${base}/auth/admin-workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(workspace.status, 200);
  adminCookie = `${adminCookie}; ${workspace.headers.get("set-cookie")!.split(";")[0]}`;
});
after(() => {
  app?.closeAllConnections();
  app?.close();
  upstream?.closeAllConnections();
  upstream?.close();
});
async function api(path: string, method = "GET", body?: any) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers:
      body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const value: any = await res.json();
  assert.ok(res.ok, JSON.stringify(value));
  return value;
}
async function makeTask(
  ids: string[],
  capability = "text",
  mode = "direct",
  maxCalls = 16,
) {
  const t = await api("/tasks", "POST", {});
  return api(`/tasks/${t.id}`, "PATCH", {
    settings: {
      ...t.settings,
      mode,
      capability,
      maxCalls,
      continuous: false,
      selections: ids.map((modelId) => ({
        providerId: provider.id,
        modelId,
        role: "",
      })),
    },
  });
}
async function run(t: any, content: string, attachments: string[] = []) {
  await api(`/tasks/${t.id}/run`, "POST", { content, attachments });
  return finished(t.id);
}
async function finished(id: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const t = await api(`/tasks/${id}`);
    if (!t.running) return t;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("task did not finish");
}
test("URL + Key discovers all upstream models and never returns the secret", async () => {
  provider = await api("/providers", "POST", {
    url: `${upstreamUrl}/chat/completions`,
    key,
  });
  assert.equal(provider.models.length, 7);
  assert.equal(provider.url, upstreamUrl);
  assert.equal(provider.protocol, "compatible");
  assert.ok(!JSON.stringify(provider).includes(key));
  assert.ok(!JSON.stringify(await api("/bootstrap")).includes(key));
  assert.ok(
    !readFileSync(join(temp, "workbench.sqlite")).includes(Buffer.from(key)),
  );
});
test("failed discovery masks the submitted API key", async () => {
  const res = await fetch(`${base}/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: upstreamUrl, key: "bad-key" }),
  });
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes("bad-key"));
});
test("later conversational models receive generated image bytes from task history", async () => {
  let t = await makeTask(["image-model"], "image");
  const imageResult = await run(t, "generate a reference image");
  assert.ok(
    imageResult.messages.some((m: any) =>
      m.attachments.some((a: any) => a.mime === "image/png"),
    ),
  );
  t = await api(`/tasks/${t.id}`, "PATCH", {
    settings: {
      ...t.settings,
      capability: "text",
      selections: [{ providerId: provider.id, modelId: "worker-a", role: "" }],
    },
  });
  const start = requests.length;
  await run(t, "Describe the actual image generated above");
  const request = requests
    .slice(start)
    .find((r) => r.path === "/v1/chat/completions");
  const imageParts = request.body.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p.type === "image_url");
  assert.equal(imageParts.length, 1);
  assert.equal(imageParts[0].image_url.url, `data:image/png;base64,${png}`);
});
test("media under .data supports complete downloads, HEAD and byte-range seeking", async () => {
  const bytes = Buffer.from(
    "video delivery fixture: exact bytes, not a decoder fixture",
  );
  const form = new FormData();
  form.append(
    "files",
    new Blob([bytes], { type: "video/mp4" }),
    "视频产出.mp4",
  );
  const [file] = await api("/files", "POST", form);
  const url = `${base}/files/${file.id}`;
  const whole = await fetch(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), bytes.length);
  const range = await fetch(url, { headers: { Range: "bytes=4-19" } });
  assert.equal(range.status, 206);
  assert.equal(
    range.headers.get("content-range"),
    `bytes 4-19/${bytes.length}`,
  );
  assert.equal(range.headers.get("content-length"), "16");
  assert.deepEqual(
    Buffer.from(await range.arrayBuffer()),
    bytes.subarray(4, 20),
  );
  const download = await fetch(`${url}?download=1`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition")!, /^attachment;/);
  assert.ok(
    download.headers
      .get("content-disposition")!
      .includes(encodeURIComponent("视频产出.mp4")),
  );
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const invalid = await fetch(url, { headers: { Range: "bytes=99999-" } });
  assert.equal(invalid.status, 416);
  assert.match(invalid.headers.get("content-type")!, /application\/json/);
  assert.equal(invalid.headers.get("content-range"), `bytes */${bytes.length}`);
  await invalid.arrayBuffer();
});
test("missing attachment bytes report a JSON 404 rather than masquerading as video", async () => {
  const form = new FormData();
  form.append(
    "files",
    new Blob(["missing"], { type: "video/mp4" }),
    "missing.mp4",
  );
  const [file] = await api("/files", "POST", form);
  unlinkSync(join(temp, "files", file.id));
  const res = await fetch(`${base}/files/${file.id}?download=1`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type")!, /application\/json/);
  assert.equal(res.headers.get("content-disposition"), null);
  assert.ok((await res.json()).error);
});
test("real HTTP streaming text persists, reconnect sends a snapshot and export works", async () => {
  const t = await makeTask(["worker-a"]);
  const done = await run(t, "hello");
  assert.equal(done.messages.at(-1).content, "真实流式响应 worker-a");
  assert.equal(done.messages.at(-1).status, "done");
  const controller = new AbortController();
  const res = await fetch(`${base}/tasks/${t.id}/events`, {
    signal: controller.signal,
  });
  const { value } = await res.body!.getReader().read();
  assert.ok(new TextDecoder().decode(value).includes("event: snapshot"));
  controller.abort();
  const exported = await fetch(`${base}/tasks/${t.id}/export?format=json`);
  assert.ok((await exported.text()).includes("worker-a"));
});
test("agents execute concurrently and call image and code-file tools in the same task", async () => {
  const t = await makeTask(
    ["worker-a", "worker-b", "image-model"],
    "text",
    "team",
    16,
  );
  const before = requests.length;
  const done = await run(t, "tool-image");
  assert.ok(maxConcurrent >= 2);
  assert.equal(done.running, false);
  assert.ok(
    done.messages.some(
      (m: any) => m.stage === "最终汇总" && m.status === "done",
    ),
  );
  const media = done.messages.find((m: any) => m.model === "image-model");
  assert.equal(media.attachments[0].mime, "image/png");
  const file = done.messages
    .flatMap((m: any) => m.attachments)
    .find((f: any) => f.name === "hello.py");
  assert.ok(file);
  assert.equal(
    await (await fetch(`${base}/files/${file.id}`)).text(),
    'print("hello")',
  );
  assert.ok(
    !done.messages.some((m: any) => m.status === "error"),
    JSON.stringify(done.messages),
  );
  const actual = requests.slice(before);
  assert.equal(
    actual.filter((r) => r.path === "/v1/images/generations").length,
    1,
  );
  const summary = actual
    .filter((r) => r.path === "/v1/chat/completions")
    .at(-1);
  assert.ok(!summary.body.tools?.length, "最终汇报不暴露生成、委派或保存工具");
  assert.ok(JSON.stringify(summary.body.messages).includes(file.url));
  assert.ok(!done.messages.some((m: any) => m.stage?.startsWith("讨论第")));
});
test("models can delegate a question to another selected conversational model", async () => {
  const t = await makeTask(["worker-a", "worker-b"], "text", "team");
  const done = await run(t, "call-peer");
  assert.ok(
    done.messages.some(
      (m: any) => m.model === "worker-b" && m.stage === "由 worker-a 调用",
    ),
  );
});
test("single invocation exposes no delegation tool even with several task members", async () => {
  const t = await makeTask(["worker-a", "worker-b"]);
  const start = requests.length;
  await run(t, "only one");
  const generations = requests
    .slice(start)
    .filter((r) => r.path === "/v1/chat/completions");
  assert.equal(generations.length, 1);
  assert.equal(generations[0].body.model, "worker-a");
  assert.ok(
    !generations[0].body.tools.some(
      (t: any) => t.function.name === "invoke_model",
    ),
  );
});
test("partial team failure is given to the summarizer instead of hidden", async () => {
  const t = await makeTask(["worker-a", "worker-b"], "text", "team");
  const before = requests.length;
  const done = await run(t, "one-member-fails");
  assert.ok(
    done.messages.some(
      (m: any) => m.role === "activity" && m.content.includes("部分完成"),
    ),
  );
  const summary = requests
    .slice(before)
    .filter((r) => r.path === "/v1/chat/completions")
    .at(-1);
  assert.equal(summary.body.model, "worker-a");
  assert.ok(JSON.stringify(summary.body.messages).includes("失败 worker-b"));
});
test("text provider parameters pass through while preserving selected model and tools", async () => {
  const t = await makeTask(["worker-b"]);
  const before = requests.length;
  await api(`/tasks/${t.id}/run`, "POST", {
    content: "parameter passthrough",
    options: {
      chat_template_kwargs: { enable_thinking: false },
      max_tokens: 128,
      model: "unselected-model",
      tools: [],
    },
  });
  const done = await finished(t.id);
  assert.equal(
    done.messages.find((m: any) => m.role === "assistant").status,
    "done",
  );
  const body = requests
    .slice(before)
    .find((r) => r.path === "/v1/chat/completions").body;
  assert.equal(body.model, "worker-b");
  assert.equal(body.max_tokens, 128);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  assert.ok(body.tools.length);
});
test("ordinary models that reject tools fall back to standard conversation", async () => {
  const t = await makeTask(["worker-b"]);
  const done = await run(t, "plain-model-without-tools");
  assert.ok(
    done.messages.some(
      (m: any) => m.role === "activity" && m.content.includes("不支持工具调用"),
    ),
  );
  const response = done.messages.find((m: any) => m.role === "assistant");
  assert.equal(response.status, "done");
  assert.equal(response.content, "真实流式响应 worker-b");
});
test("ordered workflow sends actual generated image bytes into the following video request", async () => {
  let t = await makeTask(["image-model", "video-model"]);
  t = await api(`/tasks/${t.id}`, "PATCH", {
    settings: {
      ...t.settings,
      mode: "workflow",
      workflow: [
        {
          id: "step1",
          providerId: provider.id,
          modelId: "image-model",
          capability: "image",
          prompt: "画一片森林",
          inputSource: "original",
          optionsJson: "",
        },
        {
          id: "step2",
          providerId: provider.id,
          modelId: "video-model",
          capability: "video",
          prompt: "让参考图的树叶动起来",
          inputSource: "previous",
          optionsJson: '{"seconds":"8"}',
        },
      ],
    },
  });
  const start = requests.length,
    done = await run(t, "先画图，再做视频");
  const generated = done.messages.filter((m: any) => m.role === "assistant");
  assert.equal(generated.length, 2);
  assert.equal(generated[0].attachments[0].mime, "image/png");
  assert.equal(generated[1].attachments[0].mime, "video/mp4");
  const actual = requests.slice(start);
  const imageIndex = actual.findIndex(
      (r) => r.path === "/v1/images/generations",
    ),
    videoIndex = actual.findIndex((r) => r.path === "/v1/videos");
  assert.ok(imageIndex >= 0 && videoIndex > imageIndex);
  const video = actual[videoIndex];
  assert.ok(video.body.includes("input_reference"));
  assert.ok(video.body.includes("image/png"));
  assert.ok(video.body.includes("8"));
  assert.equal(generated[1].stage, "步骤 2/2");
});
test("workflow failure stops all later steps and retains the successful earlier output", async () => {
  let t = await makeTask(["image-model", "worker-b", "video-model"]);
  t = await api(`/tasks/${t.id}`, "PATCH", {
    settings: {
      ...t.settings,
      mode: "workflow",
      workflow: [
        {
          id: "first",
          providerId: provider.id,
          modelId: "image-model",
          capability: "image",
          prompt: "",
          inputSource: "original",
          optionsJson: "",
        },
        {
          id: "bad",
          providerId: provider.id,
          modelId: "worker-b",
          capability: "text",
          prompt: "slow-request",
          inputSource: "previous",
          optionsJson: "",
        },
        {
          id: "last",
          providerId: provider.id,
          modelId: "video-model",
          capability: "video",
          prompt: "",
          inputSource: "previous",
          optionsJson: "",
        },
      ],
    },
  });
  await api(`/tasks/${t.id}/run`, "POST", { content: "test" });
  for (let i = 0; i < 40; i++) {
    const snapshot = await api(`/tasks/${t.id}`);
    if (snapshot.messages.some((m: any) => m.stage === "步骤 2/3")) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await api(`/tasks/${t.id}/stop`, "POST", {});
  const done = await finished(t.id);
  assert.ok(
    done.messages.some(
      (m: any) => m.stage === "步骤 1/3" && m.attachments.length,
    ),
  );
  assert.ok(!done.messages.some((m: any) => m.stage === "步骤 3/3"));
});
test("saved legacy continuous and multi-round tasks finish once and wait for the next user message", async () => {
  const t = await makeTask(["worker-b"], "text", "team");
  const store = await import("../server/store.ts");
  store.withOwner(store.ADMIN_OWNER, () =>
    store.putTask({
      ...t,
      settings: { ...t.settings, continuous: true, rounds: 3 },
    }),
  );
  const before = requests.length;
  const done = await run(t, "完成当前任务后汇报");
  assert.equal(done.running, false);
  assert.equal(done.settings.continuous, false);
  assert.equal(done.settings.rounds, 1);
  assert.equal(
    requests.slice(before).filter((r) => r.path === "/v1/chat/completions")
      .length,
    1,
  );
  assert.ok(!done.messages.some((m: any) => m.stage?.startsWith("讨论第")));
  const end = requests.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(requests.length, end, "完成后没有后台自动重启调用");
  const next = await run(done, "继续处理新的要求");
  assert.equal(next.running, false);
  assert.equal(
    requests.slice(end).filter((r) => r.path === "/v1/chat/completions").length,
    1,
  );
});
for (const action of ["stop", "switch"] as const) {
  test(`finite collaboration can still end on ${action} while an upstream call is active`, async () => {
    const t = await makeTask(["worker-b"], "text", "team");
    const before = requests.length;
    await api(`/tasks/${t.id}/run`, "POST", { content: "slow-request" });
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        requests.slice(before).some((r) => r.path === "/v1/chat/completions")
      ) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    try {
      assert.equal(started, true);
      if (action === "switch")
        await api(`/tasks/${t.id}`, "PATCH", {
          settings: { ...t.settings, mode: "direct" },
        });
      else await api(`/tasks/${t.id}/stop`, "POST", {});
      const done = await finished(t.id);
      assert.equal(done.running, false);
      if (action === "switch") assert.equal(done.settings.mode, "direct");
      assert.ok(
        done.messages.some(
          (m: any) => m.stage === "并行工作" && m.status === "cancelled",
        ),
      );
    } finally {
      await api(`/tasks/${t.id}/stop`, "POST", {});
    }
  });
}

for (const shape of ["object", "string"]) {
  test(`delegation accepts ${shape} API options and forwards them to media`, async () => {
    const t = await makeTask(["worker-a", "image-model"], "text", "team");
    const start = requests.length;
    const done = await run(t, `tool-image options-${shape}`);
    assert.ok(
      done.messages.some(
        (m: any) =>
          m.model === "image-model" &&
          m.status === "done" &&
          m.attachments.length,
      ),
    );
    assert.ok(
      requests
        .slice(start)
        .some(
          (r) =>
            r.path === "/v1/images/generations" && r.body.size === "1024x1024",
        ),
    );
  });
}

test("API call budget counts continuation requests after tool execution", async () => {
  const t = await makeTask(["worker-a", "image-model"], "text", "team", 2);
  const start = requests.filter((r) =>
    ["/v1/chat/completions", "/v1/images/generations"].includes(r.path),
  ).length;
  const done = await run(t, "tool-image");
  const end = requests.filter((r) =>
    ["/v1/chat/completions", "/v1/images/generations"].includes(r.path),
  ).length;
  assert.ok(end - start <= 2);
  assert.ok(done.messages.some((m: any) => m.content.includes("调用上限")));
});
test("speech, transcription, video, embedding and custom outputs stay in conversation", async () => {
  const form = new FormData();
  form.append("files", new Blob(["audio"], { type: "audio/mpeg" }), "声音.mp3");
  const [file] = await api("/files", "POST", form);
  assert.equal(file.name, "声音.mp3");
  for (const [model, cap] of [
    ["speech-model", "speech"],
    ["transcribe-model", "transcription"],
    ["video-model", "video"],
    ["embed-model", "embedding"],
  ]) {
    const t = await makeTask([model], cap);
    const done = await run(t, "test", cap === "transcription" ? [file.id] : []);
    const result = done.messages.find((m: any) => m.role === "assistant");
    assert.equal(result.status, "done", JSON.stringify(result));
    if (cap === "transcription")
      assert.equal(result.content, "音频转写测试结果");
    else assert.equal(result.attachments.length, 1);
  }
  provider = await api(`/providers/${provider.id}`, "PATCH", {
    customCapabilities: [
      {
        id: "custom-test",
        label: "自定义",
        path: "/custom",
        resultPath: "output",
      },
    ],
    models: provider.models.map((m: any) =>
      m.id === "worker-b"
        ? {
            ...m,
            capabilities: [...m.capabilities, "custom-test"],
            source: "manual",
          }
        : m,
    ),
  });
  const done = await run(
    await makeTask(["worker-b"], "custom-test"),
    "扩展测试",
  );
  assert.equal(done.messages.at(-1).content, "自定义能力：扩展测试");
});
test("stop cancels pending requests and locks provider/task edits during execution", async () => {
  const t = await makeTask(["worker-a"]);
  await api(`/tasks/${t.id}/run`, "POST", { content: "slow-request" });
  const res = await fetch(`${base}/providers/${provider.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(res.status, 409);
  await api(`/tasks/${t.id}/stop`, "POST", {});
  const done = await finished(t.id);
  assert.equal(done.running, false);
  assert.ok(done.messages.some((m: any) => m.status === "cancelled"));
});
test("same-origin checks reject cross-site mutations and hostile hosts", async () => {
  const blocked = await fetch(`${base}/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
    },
    body: "{}",
  });
  assert.equal(blocked.status, 403);
  const hostStatus = await new Promise<number>((resolve) => {
    request(`${base}/health`, { headers: { Host: "evil.example" } }, (res) => {
      resolve(res.statusCode!);
      res.resume();
    }).end();
  });
  assert.equal(hostStatus, 403);
});
test("unsupported advertised capabilities fail honestly instead of fabricating results", async () => {
  provider = await api(`/providers/${provider.id}`, "PATCH", {
    models: provider.models.map((m: any) =>
      m.id === "worker-b"
        ? {
            ...m,
            capabilities: [...m.capabilities, "unknown-action"],
            source: "manual",
          }
        : m,
    ),
  });
  const done = await run(
    await makeTask(["worker-b"], "unknown-action"),
    "test",
  );
  assert.ok(
    done.messages.some(
      (m: any) => m.status === "error" && m.content.includes("未配置"),
    ),
  );
});
