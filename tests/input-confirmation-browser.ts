import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";

process.env.WORKBENCH_DATA = mkdtempSync(
  join(tmpdir(), "mstar-confirmation-browser-"),
);
process.env.NODE_ENV = "production";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=",
  "base64",
);
const calls: string[] = [];
const fixture = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const json = (v: any) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(v));
  };
  if (req.url === "/v1/models")
    return json({
      data: [
        {
          id: "private-engine",
          capabilities: ["video"],
          input_constraints: {
            video: { accepted: ["image"], required: ["image"] },
          },
        },
      ],
    });
  if (req.url === "/v1/videos") {
    calls.push(raw);
    return json({ id: "result", status: "completed" });
  }
  if (req.url === "/v1/videos/result/content") {
    res.setHeader("Content-Type", "video/mp4");
    res.end("fixture");
    return;
  }
  res.statusCode = 404;
  json({ error: "missing" });
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const { createApp } = await import("../server/app.ts");
const { setupCode } = await import("../server/auth.ts");
const app = createApp();
app.use(express.static(resolve("dist")));
app.use((_req, res) => res.sendFile(resolve("dist/index.html")));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
mkdirSync("test-results", { recursive: true });
try {
  const admin = await browser.newContext();
  const api = async (path: string, data: any, method = "POST") => {
    const r = await admin.request.fetch(`${url}/api${path}`, { method, data });
    const value = await r.json();
    assert.ok(r.ok(), `${path}: ${JSON.stringify(value)}`);
    return value;
  };
  await api("/auth/setup", {
    code: setupCode(),
    password: "confirmation-browser-password-123",
  });
  const provider = await api("/admin/providers", {
    url: `http://127.0.0.1:${(fixture.address() as any).port}/v1`,
    key: "synthetic-key",
  });
  const upload = await admin.request.post(`${url}/api/admin/files`, {
    multipart: {
      files: { name: "forest.png", mimeType: "image/png", buffer: png },
    },
  });
  assert.ok(upload.ok());
  const files = await upload.json();
  const model = await api("/admin/models", {
    providerId: provider.id,
    modelId: "private-engine",
    name: "图片生成视频",
    capabilities: ["video"],
  });
  await api(`/admin/models/${model.id}/test`, {
    capability: "video",
    attachments: [files[0].id],
  });
  await api(`/admin/models/${model.id}`, { published: true }, "PATCH");
  const issued = await api("/admin/keys", {
    label: "测试工作空间",
    modelIds: [model.id],
  });
  const user = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await user.request.post(`${url}/api/auth/login`, {
    data: { key: issued.secret },
  });
  const page = await user.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page
    .getByRole("button", { name: "加入任务 图片生成视频", exact: true })
    .click();
  const send = async () => {
    const uploaded = page.waitForResponse(
      (r) => r.url().endsWith("/api/files") && r.request().method() === "POST",
    );
    await page
      .locator('.composer input[type="file"]')
      .setInputFiles({
        name: "forest.png",
        mimeType: "image/png",
        buffer: png,
      });
    assert.ok((await uploaded).ok());
    await page
      .getByRole("textbox", { name: "消息输入", exact: true })
      .fill("让图片中的树叶随风移动，生成视频");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page
      .getByRole("group", { name: "是否仅使用支持的输入开始任务" })
      .waitFor();
  };
  const before = calls.length;
  await send();
  assert.equal(calls.length, before);
  await page.getByText(/该模型只支持输入图片，无法识别文字描述/).waitFor();
  await page.screenshot({
    path: "test-results/input-confirmation-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  await mobile.addCookies(await user.cookies());
  const mp = await mobile.newPage();
  mp.on("pageerror", (e) => errors.push(e.message));
  await mp.goto(url);
  await mp
    .getByRole("button", { name: "是，仅用图片开始", exact: true })
    .waitFor();
  await mp
    .getByRole("button", { name: "是，仅用图片开始", exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await mp.screenshot({
    path: "test-results/input-confirmation-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await page.getByRole("button", { name: "否，暂不开始", exact: true }).click();
  await page
    .getByRole("button", { name: "停止运行", exact: true })
    .waitFor({ state: "hidden" });
  await mp.getByText("已取消本次调用。", { exact: true }).waitFor();
  assert.equal(calls.length, before);
  assert.ok(
    (await page.locator(".message-user").first().innerText()).includes(
      "让图片中的树叶",
    ),
  );
  await send();
  await mp.getByRole("button", { name: "是，仅用图片开始", exact: true }).tap();
  await page.locator(".message-assistant video").waitFor();
  await page
    .getByRole("button", { name: "停止运行", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(calls.length, before + 1);
  assert.ok(calls.at(-1)!.includes("input_reference"));
  assert.ok(!calls.at(-1)!.includes("让图片中的树叶"));
  assert.ok(!calls.at(-1)!.includes('name="prompt"'));
  assert.equal(
    await page
      .getByRole("button", { name: "是，仅用图片开始", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Input confirmation browser checks passed: persisted chat choices, no upstream request before consent, cancel, mobile touch confirmation, image-only payload, cross-tab updates and responsive layout.",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
  fixture.closeAllConnections();
  fixture.close();
}
