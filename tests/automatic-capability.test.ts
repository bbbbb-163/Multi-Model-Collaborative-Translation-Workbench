import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Model, Attachment } from "../shared/types.ts";
import { resolveCapability } from "../server/resolve-capability.ts";

process.env.WORKBENCH_DATA = mkdtempSync(join(tmpdir(), "workbench-auto-"));
const model = (capabilities: string[]): Model => ({
  id: "multi",
  name: "多模态",
  capabilities,
  source: "metadata",
});
const file = (mime: string): Attachment => ({
  id: "file",
  name: "input",
  mime,
  url: "/api/files/file",
  size: 1,
});
test("automatic routing uses only enabled capabilities and distinguishes requests from discussion", () => {
  const m = model([
    "text",
    "image",
    "video",
    "speech",
    "transcription",
    "embedding",
  ]);
  for (const [prompt, expected] of [
    ["你好", "text"],
    ["帮我画一只猫", "image"],
    ["生成一段森林视频", "video"],
    ["让这张照片动起来", "video"],
    ["请朗读这段文字", "speech"],
    ["计算文本向量", "embedding"],
    ["解释图片生成原理", "text"],
    ["这幅画的作者是谁", "text"],
    ["不要生成视频，只生成一张图片", "image"],
    ["Can you generate an image of a cat", "image"],
  ])
    assert.equal(resolveCapability(m, prompt, []), expected, prompt);
  assert.equal(
    resolveCapability(m, "转写音频内容", [file("audio/wav")]),
    "transcription",
  );
  assert.equal(
    resolveCapability(m, "去掉图片的背景", [file("image/png")]),
    "image",
  );
  assert.equal(resolveCapability(model(["text"]), "生成视频", []), "text");
  assert.equal(resolveCapability(model(["image"]), "一片森林", []), "image");
  assert.throws(
    () => resolveCapability(model(["image", "video"]), "一片森林", []),
    /任务描述/,
  );
  assert.throws(() => resolveCapability(m, "不要生成视频", []), /取消/);
});
test("custom media routing uses an enabled adapter without exposing adapter configuration", () => {
  assert.equal(
    resolveCapability(
      model(["text", "custom-video"]),
      "生成一段视频",
      [],
      [
        {
          id: "custom-video",
          label: "图生视频",
          path: "/private/generate",
          output: "video",
        },
      ],
    ),
    "custom-video",
  );
});

let server: Server,
  upstream: Server,
  base: string,
  url: string,
  cookie: string,
  admin: string,
  provider: any;
const calls: { path: string; body: any }[] = [];
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=";
async function api(path: string, method = "GET", body?: any, session = cookie) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Cookie: session || "",
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
  const value = await res.json();
  assert.ok(res.ok, JSON.stringify(value));
  return value;
}
async function createTask() {
  const t = await api("/tasks", "POST", {});
  return api(`/tasks/${t.id}`, "PATCH", {
    settings: {
      ...t.settings,
      capability: "text",
      selections: [{ providerId: provider.id, modelId: "multi", role: "" }],
    },
  });
}
async function run(t: any, content: string) {
  await api(`/tasks/${t.id}/run`, "POST", { content, autoCapabilities: true });
  for (let i = 0; i < 150; i++) {
    const result = await api(`/tasks/${t.id}`);
    if (!result.running) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not finish");
}
before(async () => {
  upstream = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const raw = Buffer.concat(parts).toString();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    calls.push({ path: req.url!, body });
    const json = (value: any) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (req.url === "/v1/models") {
      json({
        data: [{ id: "multi", capabilities: ["text", "image", "video"] }],
      });
      return;
    }
    if (
      req.url === "/v1/images/generations" ||
      req.url === "/v1/images/edits"
    ) {
      json({ data: [{ b64_json: png }] });
      return;
    }
    if (req.url === "/v1/videos") {
      json({ id: "video", status: "completed" });
      return;
    }
    if (req.url === "/v1/videos/video/content") {
      res.setHeader("Content-Type", "video/mp4");
      res.end("fixture");
      return;
    }
    if (req.url === "/v1/chat/completions") {
      if (!body.stream) {
        json({
          id: "t",
          model: "multi",
          object: "chat.completion",
          created: 0,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "测试通过" },
              finish_reason: "stop",
            },
          ],
        });
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        `data: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta: { content: "文字响应" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    res.statusCode = 404;
    json({ error: "not found" });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  url = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
  const { createApp } = await import("../server/app.ts");
  const { setupCode } = await import("../server/auth.ts");
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const setup = await fetch(`${base}/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: setupCode(),
      password: "automatic-admin-password",
    }),
  });
  admin = setup.headers.get("set-cookie")!.split(";")[0];
  const login = await fetch(`${base}/auth/admin-workspace`, {
    method: "POST",
    headers: { Cookie: admin, "Content-Type": "application/json" },
    body: "{}",
  });
  cookie = `${admin}; ${login.headers.get("set-cookie")!.split(";")[0]}`;
  provider = await api("/providers", "POST", { url, key: "fixture-key" });
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  upstream?.closeAllConnections();
  upstream?.close();
});
test("automatic invocation overrides an old hidden task choice and calls real image and video adapters", async () => {
  const t = await createTask();
  const before = calls.length;
  const image = await run(t, "生成一张森林图片");
  assert.ok(
    image.messages.some((m: any) =>
      m.attachments.some((a: any) => a.mime === "image/png"),
    ),
  );
  assert.ok(
    calls.slice(before).some((c) => c.path === "/v1/images/generations"),
  );
  assert.ok(
    !calls.slice(before).some((c) => c.path === "/v1/chat/completions"),
  );
  assert.equal(image.settings.capability, "auto");
  const video = await run(image, "生成一段森林视频");
  assert.ok(
    video.messages.some((m: any) =>
      m.attachments.some((a: any) => a.mime === "video/mp4"),
    ),
  );
});
test("automatic collaboration can generate media directly with a multi-capability member", async () => {
  let t = await createTask();
  t = await api(`/tasks/${t.id}`, "PATCH", {
    settings: { ...t.settings, mode: "team" },
  });
  const before = calls.length;
  const result = await run(t, "生成一张森林图片");
  assert.ok(
    result.messages.some((m: any) =>
      m.attachments.some((a: any) => a.mime === "image/png"),
    ),
  );
  assert.ok(
    !calls.slice(before).some((c) => c.path === "/v1/chat/completions"),
  );
});
test("automatic workflow resolves each step after receiving actual previous output", async () => {
  let t = await createTask();
  t = await api(`/tasks/${t.id}`, "PATCH", {
    settings: {
      ...t.settings,
      mode: "workflow",
      workflow: ["生成一张森林图片", "根据参考图生成视频"].map((prompt, i) => ({
        id: `step-${i}`,
        providerId: provider.id,
        modelId: "multi",
        capability: "text",
        prompt,
        inputSource: "previous",
        optionsJson: "",
      })),
    },
  });
  const result = await run(t, "完成图片到视频的顺序任务");
  assert.ok(
    result.messages.some((m: any) =>
      m.attachments.some((a: any) => a.mime === "image/png"),
    ),
  );
  assert.ok(
    result.messages.some((m: any) =>
      m.attachments.some((a: any) => a.mime === "video/mp4"),
    ),
  );
  assert.ok(
    calls
      .filter((c) => c.path === "/v1/videos")
      .at(-1)!
      .body.includes("input_reference"),
  );
});
test("automatic routing stays inside administrator-enabled Mstar capabilities", async () => {
  const p = await api(
    "/admin/providers",
    "POST",
    { url, key: "fixture-key" },
    admin,
  );
  let entry = await api(
    "/admin/models",
    "POST",
    {
      providerId: p.id,
      modelId: "multi",
      name: "文字与图片",
      capabilities: ["text", "image"],
    },
    admin,
  );
  for (const capability of entry.capabilities)
    await api(`/admin/models/${entry.id}/test`, "POST", { capability }, admin);
  entry = await api(
    `/admin/models/${entry.id}`,
    "PATCH",
    { published: true },
    admin,
  );
  const issued = await api(
    "/admin/keys",
    "POST",
    { label: "User", modelIds: [entry.id] },
    admin,
  );
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: issued.secret }),
  });
  const previous = cookie;
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  try {
    let t = await api("/tasks", "POST", {});
    t = await api(`/tasks/${t.id}`, "PATCH", {
      settings: {
        ...t.settings,
        selections: [{ providerId: entry.id, modelId: entry.id, role: "" }],
      },
    });
    const before = calls.length;
    await run(t, "生成一段视频");
    assert.ok(!calls.slice(before).some((c) => c.path === "/v1/videos"));
    const boot = await api("/bootstrap");
    assert.deepEqual(boot.providers[0].models[0].capabilities, [
      "text",
      "image",
    ]);
  } finally {
    cookie = previous;
  }
});
