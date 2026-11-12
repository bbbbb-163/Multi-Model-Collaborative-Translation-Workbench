import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";

process.env.WORKBENCH_DATA = mkdtempSync(
  join(tmpdir(), "mstar-password-browser-"),
);
process.env.NODE_ENV = "production";
const { createApp } = await import("../server/app.ts");
const { setupCode } = await import("../server/auth.ts");
const store = await import("../server/store.ts");
const app = createApp();
app.use(express.static(resolve("dist")));
app.use((_req, res) => res.sendFile(resolve("dist/index.html")));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const oldPassword = "browser-password-original-123";
const newPassword = "browser-password-replacement-456";
mkdirSync("test-results", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const setup = await context.request.post(`${url}/api/auth/setup`, {
    data: { code: setupCode(), password: oldPassword },
  });
  assert.equal(setup.status(), 200);
  const issued = await context.request.post(`${url}/api/admin/keys`, {
    data: { label: "Password browser fixture", modelIds: [] },
  });
  const { secret } = await issued.json();
  assert.equal(
    (
      await context.request.post(`${url}/api/auth/login`, {
        data: { key: secret },
      })
    ).status(),
    200,
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/admin`);
  await page.getByRole("button", { name: "账号安全", exact: true }).click();
  await page.getByRole("heading", { name: "修改登录密码" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "添加连接", exact: true }).count(),
    0,
  );
  await page.screenshot({
    path: "test-results/admin-password-desktop.png",
    fullPage: true,
  });
  const current = page.getByLabel("当前密码", { exact: true });
  const next = page.getByLabel("新密码", { exact: true });
  const confirm = page.getByLabel("确认新密码", { exact: true });
  const submit = page.getByRole("button", {
    name: "修改密码并重新登录",
    exact: true,
  });
  assert.equal(await next.getAttribute("minlength"), "12");
  assert.equal(await next.getAttribute("maxlength"), "200");
  await current.fill(oldPassword);
  await next.fill(newPassword);
  await confirm.fill("different-confirmation-password");
  await submit.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "两次输入的新密码不一致" })
    .waitFor();
  await next.fill(oldPassword);
  await confirm.fill(oldPassword);
  await submit.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "新密码不能与当前密码相同" })
    .waitFor();
  await current.fill("wrong-current-password");
  await next.fill(newPassword);
  await confirm.fill(newPassword);
  await submit.click();
  await page.getByRole("alert").filter({ hasText: "当前密码不正确" }).waitFor();
  assert.equal(await next.inputValue(), newPassword);
  await page.getByLabel("显示密码", { exact: true }).check();
  assert.equal(await next.getAttribute("type"), "text");
  await page.getByLabel("显示密码", { exact: true }).uncheck();
  assert.equal(await next.getAttribute("type"), "password");
  await page.getByRole("button", { name: "模型连接", exact: true }).click();
  await page.getByRole("button", { name: "账号安全", exact: true }).click();
  assert.equal(await current.inputValue(), "");
  assert.equal(await next.inputValue(), "");
  assert.equal(await confirm.inputValue(), "");
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  await mobile.addCookies(await context.cookies());
  const mobilePage = await mobile.newPage();
  mobilePage.on("pageerror", (error) => errors.push(error.message));
  await mobilePage.goto(`${url}/admin`);
  await mobilePage
    .getByRole("button", { name: "账号安全", exact: true })
    .click();
  await mobilePage.getByRole("heading", { name: "修改登录密码" }).waitFor();
  assert.equal(
    await mobilePage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await mobilePage.screenshot({
    path: "test-results/admin-password-mobile.png",
    fullPage: true,
  });
  // A second tab must return to login when the password is changed in this profile.
  const sibling = await context.newPage();
  sibling.on("pageerror", (error) => errors.push(error.message));
  await sibling.goto(`${url}/admin`);
  await sibling
    .getByRole("heading", { name: "模型上架", exact: true })
    .waitFor();
  await current.fill(oldPassword);
  await next.fill(newPassword);
  await confirm.fill(newPassword);
  await submit.click();
  await page
    .getByRole("heading", { name: "登录管理员后台", exact: true })
    .waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: "密码已修改，请使用新密码重新登录。" })
    .waitFor();
  assert.equal(
    await page.getByLabel("管理员密码", { exact: true }).inputValue(),
    "",
  );
  await sibling
    .getByRole("heading", { name: "登录管理员后台", exact: true })
    .waitFor({ timeout: 3000 });
  assert.equal(
    (await mobile.request.get(`${url}/api/admin/bootstrap`)).status(),
    401,
  );
  assert.equal(
    (await context.request.get(`${url}/api/bootstrap`)).status(),
    200,
  );
  await page.getByLabel("管理员密码", { exact: true }).fill(oldPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "管理员密码不正确" })
    .waitFor();
  await page.getByLabel("管理员密码", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "模型上架", exact: true }).waitFor();
  assert.equal(
    (await context.request.get(`${url}/api/admin/bootstrap`)).status(),
    200,
  );
  assert.equal(
    (await context.request.get(`${url}/api/bootstrap`)).status(),
    200,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Administrator password browser checks passed: validation, password visibility, form reset, old/new login, cross-tab logout, user-session isolation, desktop/mobile layouts.",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
  store.db.close();
}
