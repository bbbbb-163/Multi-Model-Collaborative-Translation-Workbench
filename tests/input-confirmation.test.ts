import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inferModel } from "../server/capabilities.ts";
import {
  assessInputs,
  inputConstraintsSchema,
} from "../server/input-constraints.ts";

process.env.WORKBENCH_DATA = mkdtempSync(
  join(tmpdir(), "mstar-input-confirmation-"),
);
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=";
const inputModel = {
  id: "private-image-only-video",
  capabilities: ["video"],
  input_constraints: { video: { accepted: ["image"], required: ["image"] } },
};
const calls: { path: string; body: string }[] = [];
let server: Server,
  upstream: Server,
  base: string,
  url: string,
  admin: string,
  user: string,
  other: string,
  provider: any,
  entry: any,
  imageEntry: any,
  issued: any,
  image: any;

async function request(
  path: string,
  session = user,
  method = "GET",
  body?: any,
) {
  return fetch(`${base}${path}`, {
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
}
async function api(path: string, session = user, method = "GET", body?: any) {
  const r = await request(path, session, method, body),
    value = await r.json();
  assert.ok(r.ok, `${path}: ${JSON.stringify(value)}`);
  return value;
}
async function login(key: string) {
  const r = await request("/auth/login", "", "POST", { key });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
async function task() {
  const t = await api("/tasks", user, "POST", {});
  return api(`/tasks/${t.id}`, user, "PATCH", {
    settings: {
      ...t.settings,
      selections: [{ providerId: entry.id, modelId: entry.id, role: "" }],
    },
  });
}
async function until(id: string, predicate: (t: any) => boolean) {
  for (let i = 0; i < 200; i++) {
    const t = await api(`/tasks/${id}`);
    if (predicate(t)) return t;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("task condition timed out");
}
const pending = (t: any) =>
  t.messages.find((m: any) => m.confirmation?.state === "pending");
async function begin(
  t: any,
  content = "让树叶随风移动，生成视频",
  attachments = [image.id],
) {
  await api(`/tasks/${t.id}/run`, user, "POST", {
    content,
    attachments,
    autoCapabilities: true,
  });
  return until(t.id, (value) => !!pending(value));
}
before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({ path: req.url!, body: Buffer.concat(chunks).toString() });
    const json = (v: any) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (req.url === "/v1/models")
      return json({
        data: [
          inputModel,
          { id: "private-image-generator", capabilities: ["image"] },
          {
            id: "flex-video",
            capabilities: ["video"],
            input_modalities: ["text", "image"],
          },
        ],
      });
    if (req.url === "/v1/images/generations" || req.url === "/v1/images/edits")
      return json({ data: [{ b64_json: png }] });
    if (req.url === "/v1/videos")
      return json({ id: "fixture-video", status: "completed" });
    if (req.url === "/v1/videos/fixture-video/content") {
      res.setHeader("Content-Type", "video/mp4");
      res.end("fixture");
      return;
    }
    res.statusCode = 404;
    json({ error: "missing" });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  url = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
  const { createApp } = await import("../server/app.ts");
  const { setupCode } = await import("../server/auth.ts");
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const setup = await request("/auth/setup", "", "POST", {
    code: setupCode(),
    password: "input-admin-password-1234",
  });
  admin = setup.headers.get("set-cookie")!.split(";")[0];
  provider = await api("/admin/providers", admin, "POST", {
    url,
    key: "synthetic-private-key",
  });
  const form = new FormData();
  form.append(
    "files",
    new Blob([Buffer.from(png, "base64")], { type: "image/png" }),
    "test.png",
  );
  const adminFiles = await api("/admin/files", admin, "POST", form);
  entry = await api("/admin/models", admin, "POST", {
    providerId: provider.id,
    modelId: inputModel.id,
    name: "图片生成视频",
    capabilities: ["video"],
  });
  await api(`/admin/models/${entry.id}/test`, admin, "POST", {
    capability: "video",
    attachments: [adminFiles[0].id],
  });
  await api(`/admin/models/${entry.id}`, admin, "PATCH", { published: true });
  imageEntry = await api("/admin/models", admin, "POST", {
    providerId: provider.id,
    modelId: "private-image-generator",
    name: "图片生成",
    capabilities: ["image"],
  });
  await api(`/admin/models/${imageEntry.id}/test`, admin, "POST", {
    capability: "image",
  });
  await api(`/admin/models/${imageEntry.id}`, admin, "PATCH", {
    published: true,
  });
  issued = await api("/admin/keys", admin, "POST", {
    label: "User A",
    modelIds: [entry.id, imageEntry.id],
  });
  user = await login(issued.secret);
  const otherKey = await api("/admin/keys", admin, "POST", {
    label: "User B",
    modelIds: [entry.id],
  });
  other = await login(otherKey.secret);
  const upload = new FormData();
  upload.append(
    "files",
    new Blob([Buffer.from(png, "base64")], { type: "image/png" }),
    "forest.png",
  );
  image = (await api("/files", user, "POST", upload))[0];
});
after(() => {
  server?.closeAllConnections();
  server?.close();
  upstream?.closeAllConnections();
  upstream?.close();
});

test("input limits come from explicit metadata, not a guess that all image-to-video models reject text", () => {
  const m = inferModel(inputModel, "compatible");
  const result = assessInputs(m, "video", "please animate", [
    { id: "image", mime: "image/png", size: 1, url: "", name: "image" },
  ]);
  assert.deepEqual(result.unsupported, ["text"]);
  assert.equal(result.prompt, "");
  assert.equal(result.files.length, 1);
  assert.equal(
    assessInputs(
      inferModel({ id: "i2v-model", capabilities: ["video"] }, "compatible"),
      "video",
      "animate",
      [],
    ).constraint,
    undefined,
  );
  assert.ok(
    !inputConstraintsSchema.safeParse({
      video: { accepted: ["image"], required: ["text"] },
    }).success,
  );
});
test("custom image-only templates cannot silently discard the user prompt", () => {
  const m = inferModel(
    { id: "private", capabilities: ["animate"] },
    "compatible",
  );
  const result = assessInputs(
    m,
    "animate",
    "animate leaves",
    [],
    [
      {
        id: "animate",
        label: "动画",
        path: "/animate",
        body: { image: "{{image_base64}}" },
        output: "video",
      },
    ],
  );
  assert.deepEqual(result.unsupported, ["text"]);
  assert.deepEqual(result.missing, ["image"]);
});
test("confirmation is persisted before any upstream call, and yes sends only the image exactly once", async () => {
  const t = await task(),
    before = calls.length;
  const waiting = await begin(t),
    m = pending(waiting);
  assert.ok(waiting.running);
  assert.equal(calls.length, before);
  assert.match(m.content, /只支持输入图片，无法识别文字描述/);
  assert.match(m.content, /多.*模型.*协作/);
  const fresh = await api(`/tasks/${t.id}`);
  assert.equal(pending(fresh).id, m.id);
  assert.equal(
    (
      await request(`/tasks/${t.id}/confirmations/${m.id}`, other, "POST", {
        accept: true,
      })
    ).status,
    404,
  );
  const replies = await Promise.all(
    [true, true].map((accept) =>
      request(`/tasks/${t.id}/confirmations/${m.id}`, user, "POST", { accept }),
    ),
  );
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  const done = await until(t.id, (v) => !v.running);
  const newCalls = calls.slice(before).filter((c) => c.path === "/v1/videos");
  assert.equal(newCalls.length, 1);
  assert.ok(newCalls[0].body.includes("input_reference"));
  assert.ok(!newCalls[0].body.includes("让树叶"));
  assert.ok(!newCalls[0].body.includes('name="prompt"'));
  assert.ok(
    done.messages.some((m: any) =>
      m.attachments.some((a: any) => a.mime === "video/mp4"),
    ),
  );
  assert.equal(
    done.messages.find((x: any) => x.id === m.id).confirmation.state,
    "accepted",
  );
});
test("no cancels without calling upstream and preserves the original text and image", async () => {
  const t = await task(),
    before = calls.length,
    waiting = await begin(t),
    m = pending(waiting);
  await api(`/tasks/${t.id}/confirmations/${m.id}`, user, "POST", {
    accept: false,
  });
  const done = await until(t.id, (v) => !v.running);
  assert.equal(calls.length, before);
  assert.equal(
    done.messages.find((x: any) => x.id === m.id).confirmation.state,
    "rejected",
  );
  assert.ok(
    done.messages.some(
      (m: any) =>
        m.role === "user" &&
        m.content.includes("让树叶") &&
        m.attachments[0].id === image.id,
    ),
  );
});
test("missing required image explains recovery without offering an impossible yes action", async () => {
  const t = await task(),
    before = calls.length;
  await api(`/tasks/${t.id}/run`, user, "POST", {
    content: "制作视频",
    autoCapabilities: true,
  });
  const done = await until(t.id, (v) => !v.running);
  assert.equal(calls.length, before);
  assert.ok(!pending(done));
  assert.ok(
    done.messages.some(
      (m: any) => m.role === "assistant" && /请先添加图片/.test(m.content),
    ),
  );
});
test("image-only input starts immediately without a redundant confirmation", async () => {
  const t = await task(),
    before = calls.length;
  await api(`/tasks/${t.id}/run`, user, "POST", {
    content: "",
    attachments: [image.id],
    autoCapabilities: true,
  });
  const done = await until(t.id, (v) => !v.running);
  assert.ok(!done.messages.some((m: any) => m.confirmation));
  assert.equal(
    calls.slice(before).filter((c) => c.path === "/v1/videos").length,
    1,
  );
});
test("stopping a waiting task invalidates its choice without calling upstream", async () => {
  const t = await task(),
    before = calls.length,
    waiting = await begin(t),
    m = pending(waiting);
  await api(`/tasks/${t.id}/stop`, user, "POST", {});
  const done = await until(t.id, (v) => !v.running);
  assert.equal(
    done.messages.find((x: any) => x.id === m.id).confirmation.state,
    "cancelled",
  );
  assert.equal(
    (
      await request(`/tasks/${t.id}/confirmations/${m.id}`, user, "POST", {
        accept: true,
      })
    ).status,
    409,
  );
  assert.equal(calls.length, before);
});
test("workflow pauses at the restricted step, then uses its actual image without the step description", async () => {
  let t = await task();
  t = await api(`/tasks/${t.id}`, user, "PATCH", {
    settings: {
      ...t.settings,
      mode: "workflow",
      selections: [
        ...t.settings.selections,
        { providerId: imageEntry.id, modelId: imageEntry.id, role: "" },
      ],
      workflow: [
        {
          id: "step1",
          providerId: imageEntry.id,
          modelId: imageEntry.id,
          capability: "auto",
          prompt: "生成一张森林图片",
          inputSource: "original",
          optionsJson: "",
        },
        {
          id: "step2",
          providerId: entry.id,
          modelId: entry.id,
          capability: "auto",
          prompt: "让树叶动起来",
          inputSource: "previous",
          optionsJson: "",
        },
      ],
    },
  });
  const before = calls.length,
    waiting = await begin(t),
    m = pending(waiting);
  assert.equal(
    calls.slice(before).filter((c) => c.path === "/v1/videos").length,
    0,
  );
  const generated = waiting.messages
    .flatMap((m: any) => (m.role === "assistant" ? m.attachments : []))
    .find((a: any) => a.mime === "image/png");
  assert.ok(generated);
  assert.notEqual(generated.id, image.id);
  await api(`/tasks/${t.id}/confirmations/${m.id}`, user, "POST", {
    accept: true,
  });
  await until(t.id, (v) => !v.running);
  assert.equal(
    calls.slice(before).filter((c) => c.path === "/v1/videos").length,
    1,
  );
  assert.ok(!calls.at(-2)!.body.includes("让树叶"));
  assert.ok(calls.at(-2)!.body.includes(generated.name));
});
test("parallel media collaboration also waits for an explicit input decision", async () => {
  let t = await task();
  t = await api(`/tasks/${t.id}`, user, "PATCH", {
    settings: { ...t.settings, mode: "team" },
  });
  const before = calls.length,
    waiting = await begin(t),
    m = pending(waiting);
  assert.equal(calls.length, before);
  await api(`/tasks/${t.id}/confirmations/${m.id}`, user, "POST", {
    accept: true,
  });
  await until(t.id, (v) => !v.running);
  assert.equal(
    calls.slice(before).filter((c) => c.path === "/v1/videos").length,
    1,
  );
});
test("revoking authorization cancels a pending decision and cannot be bypassed with a stale yes", async () => {
  const t = await task(),
    before = calls.length,
    waiting = await begin(t),
    m = pending(waiting);
  const boot = await api("/bootstrap");
  const serialized = JSON.stringify(boot);
  assert.ok(!serialized.includes("inputConstraints"));
  assert.ok(!serialized.includes(inputModel.id));
  assert.ok(!serialized.includes("synthetic-private-key"));
  await api(`/admin/keys/${issued.key.id}`, admin, "PATCH", { modelIds: [] });
  const done = await until(t.id, (v) => !v.running);
  assert.equal(
    done.messages.find((x: any) => x.id === m.id).confirmation.state,
    "cancelled",
  );
  assert.equal(
    (
      await request(`/tasks/${t.id}/confirmations/${m.id}`, user, "POST", {
        accept: true,
      })
    ).status,
    409,
  );
  assert.equal(calls.length, before);
});
