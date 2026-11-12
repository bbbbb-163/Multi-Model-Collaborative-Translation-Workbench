import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";

process.env.WORKBENCH_DATA = mkdtempSync(join(tmpdir(), "mstar-browser-"));
process.env.NODE_ENV = "production";
const upstreamKey = "fixture-private-upstream-key";
const fixture = createServer(async (req, res) => {
  const parts: Buffer[] = [];
  for await (const p of req) parts.push(Buffer.from(p));
  const raw = Buffer.concat(parts).toString();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  const json = (v: any) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(v));
  };
  assert.equal(req.headers.authorization, `Bearer ${upstreamKey}`);
  if (req.url === "/v1/models") {
    json({
      data: [
        { id: "private-writer", capabilities: ["text"] },
        { id: "private-video", capabilities: ["video"] },
      ],
    });
    return;
  }
  if (req.url === "/v1/chat/completions") {
    if (!body.stream) {
      json({
        id: "t",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "连通测试成功" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      `data: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta: { content: "Mstar 浏览器测试响应" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "t", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  if (req.url === "/v1/videos") {
    json({ id: "job-test", status: "completed" });
    return;
  }
  if (req.url === "/v1/videos/job-test/content") {
    res.setHeader("Content-Type", "video/mp4");
    res.end("fixture");
    return;
  }
  res.statusCode = 404;
  json({ error: "missing" });
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const upstreamUrl = `http://127.0.0.1:${(fixture.address() as any).port}/v1`;
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
  const admin = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const ap = await admin.newPage();
  ap.on("pageerror", (e) => errors.push(e.message));
  await ap.goto(url);
  await ap.getByRole("heading", { name: "进入你的工作台" }).waitFor();
  await ap.screenshot({
    path: "test-results/mstar-login-desktop.png",
    fullPage: true,
  });
  await ap.goto(`${url}/admin`);
  await ap.getByLabel("初始化码", { exact: true }).fill(setupCode()!);
  await ap
    .getByLabel("管理员密码", { exact: true })
    .fill("browser-admin-password-123");
  await ap
    .getByLabel("确认密码", { exact: true })
    .fill("browser-admin-password-123");
  await ap.getByRole("button", { name: "设置密码并进入后台" }).click();
  await ap.getByRole("heading", { name: "模型上架", exact: true }).waitFor();
  await ap.getByRole("button", { name: "添加模型", exact: true }).click();
  await ap.getByLabel("API 地址", { exact: true }).fill(upstreamUrl);
  await ap.getByLabel("API Key", { exact: true }).fill(upstreamKey);
  assert.equal(
    await ap.locator(".advanced-settings").getAttribute("open"),
    null,
  );
  await ap.getByRole("button", { name: "连接并获取模型", exact: true }).click();
  await ap.getByLabel("展示名称", { exact: true }).fill("文字助手");
  assert.equal(
    await ap.locator(".admin-capabilities input[type=checkbox]").count(),
    1,
  );
  await ap.getByRole("button", { name: "保存草稿", exact: true }).click();
  await ap
    .getByText("草稿已保存。测试全部能力通过后即可上架。", { exact: true })
    .waitFor();
  assert.equal(
    await ap
      .getByRole("button", { name: "上架到 Mstar", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await ap.locator(".admin-test-options").getAttribute("open"),
    null,
  );
  await ap.locator(".admin-test-options > summary").click();
  await ap.getByLabel("测试内容", { exact: true }).fill("请简短确认测试连接。");
  assert.ok(
    await ap
      .getByRole("button", { name: "选择测试附件", exact: true })
      .isVisible(),
  );
  await ap.locator(".admin-test-options > summary").click();
  await ap.getByRole("button", { name: "对话与编码测试", exact: true }).click();
  await ap.getByText("对话与编码测试通过。", { exact: true }).waitFor();
  await ap.getByRole("button", { name: "上架到 Mstar", exact: true }).click();
  await ap.getByRole("button", { name: "下架模型", exact: true }).waitFor();
  await ap.getByRole("button", { name: "添加模型", exact: true }).click();
  await ap.getByLabel("展示名称", { exact: true }).fill("视频生成");
  await ap.getByRole("combobox", { name: "上游模型", exact: true }).click();
  await ap.getByRole("option", { name: "private-video", exact: true }).click();
  await ap.getByRole("button", { name: "保存草稿", exact: true }).click();
  await ap
    .getByText("草稿已保存。测试全部能力通过后即可上架。", { exact: true })
    .waitFor();
  await ap.getByRole("button", { name: "视频生成测试", exact: true }).click();
  await ap.getByText("视频生成测试通过。", { exact: true }).waitFor();
  await ap.getByRole("button", { name: "上架到 Mstar", exact: true }).click();
  await ap.getByRole("button", { name: "下架模型", exact: true }).waitFor();
  await ap.locator(".admin-row").filter({ hasText: "文字助手" }).click();
  await ap.screenshot({
    path: "test-results/mstar-admin-desktop.png",
    fullPage: true,
  });
  await ap.getByRole("button", { name: "模型连接", exact: true }).click();
  await ap.locator(".admin-row").first().click();
  await ap.screenshot({
    path: "test-results/mstar-admin-provider-desktop.png",
    fullPage: true,
  });
  await ap.getByRole("button", { name: "分发密钥", exact: true }).click();
  await ap.getByRole("button", { name: "生成密钥", exact: true }).click();
  await ap.getByLabel("密钥名称", { exact: true }).fill("客户 A");
  await ap
    .locator(".grant-list label")
    .filter({ hasText: "文字助手" })
    .locator("input")
    .check();
  await ap.getByRole("button", { name: "生成分发密钥", exact: true }).click();
  const secret = (await ap.locator(".key-secret-value").innerText()).trim();
  assert.match(secret, /^mstar_/);
  const user = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const up = await user.newPage();
  up.on("pageerror", (e) => errors.push(e.message));
  await up.goto(url);
  await up.getByLabel("Mstar 密钥", { exact: true }).fill(secret);
  await up.getByRole("button", { name: "登录", exact: true }).click();
  await up.locator(".welcome").waitFor();
  assert.equal(
    await up
      .getByRole("tab", { name: "Mstar", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await up.locator(".mstar-model").count(), 1);
  assert.equal(
    await up
      .getByRole("button", { name: "加入任务 视频生成", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await up.getByRole("button", { name: "添加连接", exact: true }).count(),
    0,
  );
  const boot = await (await user.request.get(`${url}/api/bootstrap`)).text();
  for (const value of [
    upstreamKey,
    upstreamUrl,
    "private-writer",
    "private-video",
  ])
    assert.ok(!boot.includes(value));
  assert.equal(
    (await user.request.get(`${url}/api/admin/bootstrap`)).status(),
    401,
  );
  await up
    .getByRole("button", { name: "加入任务 文字助手", exact: true })
    .click();
  await up.locator(".member-item").waitFor();
  assert.equal(
    await up.getByRole("combobox", { name: "调用能力", exact: true }).count(),
    0,
  );
  assert.equal(await up.locator(".member-item strong").innerText(), "文字助手");
  await up.getByRole("textbox", { name: "消息输入", exact: true }).fill("你好");
  await up.getByRole("button", { name: "发送消息", exact: true }).click();
  await up.getByText("Mstar 浏览器测试响应", { exact: true }).waitFor();
  await up
    .getByRole("button", { name: "停止运行", exact: true })
    .waitFor({ state: "hidden" });
  await up.screenshot({
    path: "test-results/mstar-workbench-desktop.png",
    fullPage: true,
  });
  await up.getByRole("tab", { name: "我的模型", exact: true }).click();
  assert.equal(await up.locator(".provider-group").count(), 0);
  await up
    .getByRole("button", { name: "添加连接", exact: true })
    .first()
    .waitFor();
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    isMobile: true,
    hasTouch: true,
  });
  const mp = await mobile.newPage();
  mp.on("pageerror", (e) => errors.push(e.message));
  await mp.goto(url);
  await mp.getByRole("heading", { name: "进入你的工作台" }).waitFor();
  await mp.screenshot({
    path: "test-results/mstar-login-mobile.png",
    fullPage: true,
  });
  await mobile.addCookies(await user.cookies());
  await mp.reload();
  await mp.getByText("Mstar 浏览器测试响应", { exact: true }).waitFor();
  await mp.screenshot({
    path: "test-results/automatic-capability-mobile.png",
    fullPage: true,
  });
  await mp.getByRole("button", { name: "模型", exact: true }).click();
  await mp.locator(".mstar-model").waitFor();
  assert.equal(
    await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await mp.screenshot({
    path: "test-results/mstar-workbench-mobile.png",
    fullPage: true,
  });
  const ma = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    isMobile: true,
    hasTouch: true,
  });
  await ma.addCookies(await admin.cookies());
  const map = await ma.newPage();
  map.on("pageerror", (e) => errors.push(e.message));
  await map.goto(`${url}/admin`);
  await map.locator(".admin-row").filter({ hasText: "文字助手" }).click();
  assert.equal(
    await map.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await map.screenshot({
    path: "test-results/mstar-admin-mobile.png",
    fullPage: true,
  });
  await map.getByRole("button", { name: "模型连接", exact: true }).click();
  await map.locator(".admin-row").first().click();
  await map.screenshot({
    path: "test-results/mstar-admin-provider-mobile.png",
    fullPage: true,
  });
  await ap
    .locator(".grant-list label")
    .filter({ hasText: "视频生成" })
    .locator("input")
    .check();
  await ap.getByRole("button", { name: "保存授权", exact: true }).click();
  await ap
    .getByText("授权已更新，相关运行已停止，新权限立即生效。", { exact: true })
    .waitFor();
  await up.reload();
  await up
    .getByRole("button", { name: "加入任务 视频生成", exact: true })
    .waitFor();
  // Reproduce two tabs in one browser profile, with both cookies present.
  const dual = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const dualLogin = await dual.request.post(`${url}/api/auth/admin`, {
    data: { password: "browser-admin-password-123" },
  });
  assert.equal(dualLogin.status(), 200);
  const dualUser = await dual.newPage(),
    dualAdmin = await dual.newPage();
  dualUser.on("pageerror", (e) => errors.push(e.message));
  dualAdmin.on("pageerror", (e) => errors.push(e.message));
  await dualUser.goto(url);
  await dualUser
    .getByRole("heading", { name: "进入你的工作台", exact: true })
    .waitFor();
  await dualUser.getByLabel("Mstar 密钥", { exact: true }).fill(secret);
  await dualUser.getByRole("button", { name: "登录", exact: true }).click();
  await dualUser.locator(".app-shell").waitFor();
  await dualAdmin.goto(`${url}/admin`);
  await dualAdmin
    .getByRole("heading", { name: "模型上架", exact: true })
    .waitFor();
  const sibling = await dual.newPage();
  sibling.on("pageerror", (e) => errors.push(e.message));
  await sibling.goto(url);
  await sibling.locator(".app-shell").waitFor();
  await dualUser.getByRole("button", { name: "退出登录", exact: true }).click();
  await sibling
    .getByRole("heading", { name: "进入你的工作台", exact: true })
    .waitFor({ timeout: 3000 });
  await dualUser
    .getByRole("heading", { name: "进入你的工作台", exact: true })
    .waitFor();
  await dualUser.reload();
  await dualUser
    .getByRole("heading", { name: "进入你的工作台", exact: true })
    .waitFor();
  await dualAdmin.reload();
  await dualAdmin
    .getByRole("heading", { name: "模型上架", exact: true })
    .waitFor();
  assert.equal((await dual.request.get(`${url}/api/bootstrap`)).status(), 401);
  assert.equal(
    (await dual.request.get(`${url}/api/admin/bootstrap`)).status(),
    200,
  );
  await dualUser.getByLabel("Mstar 密钥", { exact: true }).fill(secret);
  await dualUser.getByRole("button", { name: "登录", exact: true }).click();
  await dualUser.locator(".app-shell").waitFor();
  await dualAdmin
    .getByRole("button", { name: "退出管理员登录", exact: true })
    .click();
  await dualAdmin
    .getByRole("heading", { name: "登录管理员后台", exact: true })
    .waitFor();
  await dualUser.reload();
  await dualUser.locator(".app-shell").waitFor();
  assert.equal((await dual.request.get(`${url}/api/bootstrap`)).status(), 200);
  assert.equal(
    (await dual.request.get(`${url}/api/admin/bootstrap`)).status(),
    401,
  );
  await dual.close();
  await ap
    .getByRole("checkbox", { name: "允许此密钥登录和使用模型", exact: true })
    .uncheck();
  await ap.getByRole("button", { name: "保存授权", exact: true }).click();
  await ap
    .getByText("授权已更新，相关运行已停止，新权限立即生效。", { exact: true })
    .waitFor();
  await up.reload();
  await up
    .getByRole("heading", { name: "进入你的工作台", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Mstar browser checks passed: admin setup, URL/key discovery, draft/test/publish, issued-key login and grants, safe catalog, use in workspace, grant edits, revocation, CSP, desktop/mobile layouts.",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
  fixture.closeAllConnections();
  fixture.close();
}
