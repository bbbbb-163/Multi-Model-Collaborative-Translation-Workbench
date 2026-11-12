import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { chromium } from "playwright";

process.env.WORKBENCH_DATA = join(
  mkdtempSync(join(tmpdir(), "workbench-browser-")),
  ".data",
);
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=";
const calls: { url: string; body: string }[] = [];
const fixture = createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  const raw = Buffer.concat(parts).toString();
  calls.push({ url: req.url!, body: raw });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/v1/models") {
    res.end(
      JSON.stringify({
        data: [
          { id: "writer", capabilities: ["text"] },
          { id: "image-maker", capabilities: ["image"] },
          { id: "video-maker", capabilities: ["video"] },
        ],
      }),
    );
    return;
  }
  if (req.url === "/v1/images/generations") {
    res.end(JSON.stringify({ data: [{ b64_json: png }] }));
    return;
  }
  if (req.url === "/v1/videos") {
    res.end(JSON.stringify({ id: "v1", status: "completed" }));
    return;
  }
  if (req.url === "/v1/videos/v1/content") {
    res.setHeader("Content-Type", "video/mp4");
    res.end("fixture");
    return;
  }
  if (req.url === "/v1/chat/completions") {
    res.setHeader("Content-Type", "text/event-stream");
    res.end(
      `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { content: "浏览器集成测试响应" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const upstreamUrl = `http://127.0.0.1:${(fixture.address() as any).port}/v1`;
const { createApp } = await import("../server/app.ts");
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const { setupCode } = await import("../server/auth.ts");
  const login = await context.request.post(`${url}/api/auth/setup`, {
    data: { code: setupCode(), password: "browser-admin-password" },
  });
  assert.equal(login.status(), 200);
  const workspaceLogin = await context.request.post(
    `${url}/api/auth/admin-workspace`,
    { data: {} },
  );
  assert.equal(workspaceLogin.status(), 200);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator(".welcome").waitFor();
  await page.screenshot({
    path: "test-results/desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  const helpTrigger = page.getByRole("button", {
    name: "使用说明",
    exact: true,
  });
  const helpPanel = page.locator(".help-panel:popover-open");
  assert.equal(await helpPanel.count(), 0);
  await helpTrigger.hover();
  await helpPanel.waitFor();
  const helpBounds = (await helpPanel.boundingBox())!;
  const helpTriggerBounds = (await helpTrigger.boundingBox())!;
  const workspaceLabelBounds = (await page
    .locator(".workspace-meta small")
    .boundingBox())!;
  assert.ok(
    helpTriggerBounds.x >= workspaceLabelBounds.x + workspaceLabelBounds.width,
  );
  assert.ok(helpTriggerBounds.width < 24, "问号使用紧凑尺寸");
  assert.ok(
    helpBounds.y + helpBounds.height < helpTriggerBounds.y,
    "说明在图标附近向上展开",
  );
  await page.mouse.move(helpBounds.x + 30, helpBounds.y + 40, { steps: 5 });
  await page.waitForTimeout(250);
  assert.equal(await helpPanel.isVisible(), true, "鼠标进入说明后保持可读");
  await page.screenshot({
    path: "test-results/help-hover-desktop.png",
    fullPage: true,
  });
  await page.locator(".workspace-header h1").hover();
  await helpPanel.waitFor({ state: "hidden" });
  await helpTrigger.focus();
  await helpPanel.waitFor();
  await page.keyboard.press("Escape");
  await helpPanel.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".task-sidebar.open").count(), 1);
  await page.locator(".workspace-header h1").click();
  const taskActions = page.locator(".task-row").first().locator(".task-more");
  const openTaskMenu = page.locator(".task-menu:popover-open");
  await taskActions.click();
  await openTaskMenu.waitFor();
  await page.waitForFunction(() =>
    document.querySelector('.task-more[aria-expanded="true"]'),
  );
  const triggerBounds = (await taskActions.boundingBox())!;
  const menuBounds = (await openTaskMenu.boundingBox())!;
  assert.ok(menuBounds.x >= triggerBounds.x + triggerBounds.width);
  await page
    .getByRole("textbox", { name: "任务名称", exact: true })
    .fill("编辑中的名称");
  assert.equal(await openTaskMenu.count(), 1, "编辑菜单内容时保持展开");
  await page.screenshot({
    path: "test-results/task-menu-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.locator(".workspace-header h1").click();
  await openTaskMenu.waitFor({ state: "hidden" });
  await taskActions.click();
  await openTaskMenu.waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "任务名称", exact: true })
      .inputValue(),
    "新任务",
  );
  await taskActions.click();
  await openTaskMenu.waitFor({ state: "hidden" });
  await taskActions.click();
  await openTaskMenu.waitFor();
  await page.getByRole("textbox", { name: "搜索任务", exact: true }).click();
  await openTaskMenu.waitFor({ state: "hidden" });
  await taskActions.click();
  await openTaskMenu.waitFor();
  await page.keyboard.press("Escape");
  await openTaskMenu.waitFor({ state: "hidden" });
  const dropdown = page.locator(".select-dropdown:popover-open");
  const modeControl = page.getByRole("combobox", {
    name: "调用方式",
    exact: true,
  });
  await modeControl.click();
  await dropdown.waitFor();
  assert.equal(await dropdown.getByRole("option").count(), 3);
  assert.equal(
    await dropdown.getByRole("option", { selected: true }).innerText(),
    "单独调用",
  );
  assert.equal(
    await modeControl.evaluate((el) => getComputedStyle(el).outlineStyle),
    "none",
  );
  const modeBounds = (await modeControl.boundingBox())!;
  const dropdownBounds = (await dropdown.boundingBox())!;
  assert.ok(
    dropdownBounds.y + dropdownBounds.height <= modeBounds.y,
    "底部下拉框向上展开",
  );
  await page.screenshot({
    path: "test-results/select-mode-desktop.png",
    fullPage: true,
  });
  await page.locator(".workspace-header h1").click();
  await dropdown.waitFor({ state: "hidden" });
  await modeControl.focus();
  await page.keyboard.press("ArrowDown");
  await dropdown.waitFor();
  assert.notEqual(
    await modeControl.getAttribute("aria-activedescendant"),
    null,
  );
  await page.keyboard.press("Escape");
  await dropdown.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".task-sidebar.open").count(), 1);
  await modeControl.click();
  await dropdown.waitFor();
  await modeControl.click();
  await dropdown.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "任务设置", exact: true }).click();
  assert.equal(
    await page.getByRole("combobox", { name: "协作轮数", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "关闭任务设置", exact: true }).click();
  await page.getByRole("tab", { name: "我的模型", exact: true }).click();
  await page
    .getByRole("button", { name: "添加连接", exact: true })
    .first()
    .click();
  await page.locator(".advanced-settings > summary").click();
  await page.getByRole("combobox", { name: "接口协议", exact: true }).click();
  await dropdown.waitFor();
  assert.equal(await dropdown.getByRole("option").count(), 5);
  await page.screenshot({
    path: "test-results/select-protocol-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("option", {
      name: "OpenAI 兼容 · Chat Completions",
      exact: true,
    })
    .click();
  await page.getByLabel("API 地址", { exact: true }).fill(upstreamUrl);
  assert.equal(
    await page
      .getByLabel("API 地址", { exact: true })
      .evaluate((el) => getComputedStyle(el).outlineStyle),
    "none",
  );
  await page.getByLabel("API Key", { exact: true }).fill("test-browser-key");
  await page.getByRole("button", { name: "连接并获取模型" }).click();
  await page.locator(".provider-group").waitFor();
  await page.getByRole("button", { name: /^管理连接 / }).click();
  await page.locator(".readonly-provider-model").first().waitFor();
  assert.equal(await page.locator(".capability-options input").count(), 0);
  assert.equal(
    await page.getByText("扩展能力定义", { exact: true }).count(),
    0,
  );
  assert.ok(
    (
      await page.locator(".readonly-provider-model").first().innerText()
    ).includes("对话与编码"),
  );
  await page.getByRole("button", { name: "返回模型列表", exact: true }).click();
  assert.equal(await page.locator(".model-option:visible").count(), 0);
  await page.locator(".provider-expand").click();
  assert.equal(await page.locator(".model-option:visible").count(), 3);
  await page.locator(".provider-expand").click();
  assert.equal(await page.locator(".model-option:visible").count(), 0);
  await page.locator(".provider-expand").click();
  for (const id of ["writer", "image-maker", "video-maker"]) {
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes("/api/tasks/") && r.request().method() === "PATCH",
    );
    await page
      .getByRole("checkbox", { name: `加入任务 ${id}`, exact: true })
      .click();
    await saved;
  }
  assert.equal(await page.locator(".member-item").count(), 3);
  const select = async (label: string, option: string) => {
    const control = page.getByRole("combobox", { name: label, exact: true });
    const changed = (await control.innerText()).trim() !== option;
    const saved = changed
      ? page.waitForResponse(
          (r) =>
            r.url().includes("/api/tasks/") && r.request().method() === "PATCH",
        )
      : Promise.resolve();
    await control.click();
    await page.getByRole("option", { name: option, exact: true }).click();
    await saved;
  };
  await modeControl.focus();
  await page.keyboard.press("Home");
  await dropdown.waitFor();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() =>
    document
      .querySelector('.select-dropdown:popover-open [data-active="true"]')
      ?.textContent?.includes("自动协作"),
  );
  const keyboardSave = page.waitForResponse(
    (r) => r.url().includes("/api/tasks/") && r.request().method() === "PATCH",
  );
  await page.keyboard.press("Enter");
  await keyboardSave;
  assert.equal(await modeControl.innerText(), "自动协作");
  await select("调用方式", "单独调用");
  await modeControl.click();
  await dropdown.waitFor();
  await page.keyboard.press("Tab");
  await dropdown.waitFor({ state: "hidden" });
  await select("本次调用模型", "writer");
  assert.equal(
    await page.getByRole("combobox", { name: "调用能力", exact: true }).count(),
    0,
  );
  await page.getByRole("textbox", { name: "消息输入" }).fill("只调用 writer");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.getByText("浏览器集成测试响应", { exact: true }).waitFor();
  assert.equal(calls.filter((c) => c.url === "/v1/chat/completions").length, 1);
  await page
    .getByRole("button", { name: "停止运行" })
    .waitFor({ state: "hidden" });
  await select("调用方式", "自动协作");
  await page
    .getByRole("textbox", { name: "消息输入" })
    .fill("完成当前协作任务后直接汇报");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".message-assistant").length === 2 &&
      !document.querySelector('[aria-label="停止运行"]'),
  );
  assert.equal(calls.filter((c) => c.url === "/v1/chat/completions").length, 2);
  assert.equal(await page.locator(".run-status").count(), 0);
  assert.ok(!(await page.locator(".messages").innerText()).includes("讨论第"));
  await page.screenshot({
    path: "test-results/team-finished-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  const teamMobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  await teamMobile.addCookies(await context.cookies());
  const tmp = await teamMobile.newPage();
  tmp.on("pageerror", (e) => errors.push(e.message));
  await tmp.goto(url);
  await tmp.locator(".message-assistant").last().waitFor();
  assert.equal(
    await tmp.getByRole("button", { name: "停止运行", exact: true }).count(),
    0,
  );
  assert.equal(
    await tmp.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await tmp.screenshot({
    path: "test-results/team-finished-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await teamMobile.close();
  await page.reload();
  await page.locator(".message-assistant").last().waitFor();
  assert.equal(
    await page.getByRole("button", { name: "停止运行", exact: true }).count(),
    0,
  );
  await select("调用方式", "顺序执行");
  const workflowPopup = page.locator(".workflow-editor:popover-open");
  const chatHeight = await page
    .locator(".chat-scroll")
    .evaluate((el) => el.clientHeight);
  await page.getByRole("button", { name: "管理顺序步骤", exact: true }).click();
  await page.locator(".workflow-editor").waitFor();
  assert.equal(
    await page.locator(".chat-scroll").evaluate((el) => el.clientHeight),
    chatHeight,
    "步骤浮窗不挤占对话区高度",
  );
  assert.equal(await page.locator(".workflow-step").count(), 3);
  assert.equal(
    await page.getByRole("combobox", { name: /步骤 \d+ 能力/ }).count(),
    0,
  );
  await page
    .getByRole("combobox", { name: "步骤 1 模型", exact: true })
    .click();
  await dropdown.waitFor();
  assert.equal(await dropdown.getByRole("option").count(), 3);
  const workflowControlBounds = (await page
    .getByRole("combobox", { name: "步骤 1 模型", exact: true })
    .boundingBox())!;
  const workflowDropdownBounds = (await dropdown.boundingBox())!;
  assert.ok(
    Math.abs(workflowControlBounds.x - workflowDropdownBounds.x) < 1,
    "工作流列表紧邻触发框展开",
  );
  await page.screenshot({
    path: "test-results/select-workflow-desktop.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  assert.equal(
    await workflowPopup.isVisible(),
    true,
    "关闭内部下拉框后步骤浮窗保持可见",
  );
  await page
    .locator(".workflow-step")
    .nth(1)
    .locator(".step-details > summary")
    .click();
  await select("步骤 2 输入来源", "所有前序步骤的产出");
  await select("步骤 2 输入来源", "上一步的产出");
  await page
    .locator(".workflow-step")
    .nth(1)
    .locator(".step-details > summary")
    .click();
  const patch = page.waitForResponse(
    (r) => r.url().includes("/api/tasks/") && r.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "删除步骤 1", exact: true }).click();
  await patch;
  assert.equal(await page.locator(".workflow-step").count(), 2);
  await page.getByRole("textbox", { name: "消息输入" }).click();
  await page
    .getByRole("textbox", { name: "消息输入" })
    .fill("先画一张森林，再用图生成视频");
  await workflowPopup.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "管理顺序步骤", exact: true }).click();
  await workflowPopup.waitFor();
  await page.screenshot({
    path: "test-results/workflow-config.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator("video").waitFor();
  await page
    .getByRole("button", { name: "停止运行" })
    .waitFor({ state: "hidden" });
  assert.ok(
    calls.find((c) => c.url === "/v1/videos")?.body.includes("input_reference"),
  );
  await page.reload();
  await page.locator("video").waitFor();
  assert.equal(await page.locator(".member-item").count(), 3);
  assert.equal(
    await page
      .getByRole("combobox", { name: "调用方式", exact: true })
      .innerText(),
    "顺序执行",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: "test-results/workflow-result.png",
    fullPage: true,
    animations: "disabled",
  });
  const before = await page.locator(".task-row").count();
  await page.getByRole("button", { name: "新建任务 新对话" }).click();
  await page.locator(".welcome").waitFor();
  assert.equal(await page.locator(".task-row").count(), before + 1);
  await page.getByRole("button", { name: "收起任务列表" }).click();
  await page.getByRole("button", { name: "展开任务列表" }).waitFor();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.locator(".model-drawer.open").waitFor({ state: "hidden" });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  await mobile.addCookies(await context.cookies());
  const mp = await mobile.newPage();
  mp.on("pageerror", (e) => errors.push(e.message));
  await mp.goto(url);
  await mp.locator(".welcome").waitFor();
  assert.equal(
    await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await mp.screenshot({
    path: "test-results/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await mp.getByRole("combobox", { name: "调用方式", exact: true }).tap();
  const mobileDropdown = mp.locator(".select-dropdown:popover-open");
  await mobileDropdown.waitFor();
  const mobileSelectBounds = (await mobileDropdown.boundingBox())!;
  assert.ok(
    mobileSelectBounds.x >= 8 &&
      mobileSelectBounds.x + mobileSelectBounds.width <= 382,
  );
  assert.ok(
    mobileSelectBounds.y >= 8 &&
      mobileSelectBounds.y + mobileSelectBounds.height <= 836,
  );
  await mp.screenshot({
    path: "test-results/select-mode-mobile.png",
    fullPage: true,
  });
  await mp.getByRole("option", { name: "单独调用", exact: true }).tap();
  await mobileDropdown.waitFor({ state: "hidden" });
  await mp.getByRole("button", { name: "模型", exact: true }).click();
  await mp.locator(".model-drawer.open").waitFor();
  assert.equal(
    await mp.locator(".model-drawer").getAttribute("role"),
    "dialog",
  );
  assert.equal(
    await mp.locator(".model-drawer").getAttribute("aria-modal"),
    "true",
  );
  assert.equal(await mp.locator("main").getAttribute("inert"), "");
  for (let i = 0; i < 15; i++) {
    await mp.keyboard.press("Tab");
    assert.equal(
      await mp.evaluate(
        () => !!document.activeElement?.closest(".model-drawer"),
      ),
      true,
    );
  }
  await mp.screenshot({
    path: "test-results/mobile-drawer.png",
    fullPage: true,
    animations: "disabled",
  });
  await mp.keyboard.press("Escape");
  await mp.locator(".model-drawer.open").waitFor({ state: "hidden" });
  assert.equal(
    await mp.evaluate(() =>
      document.activeElement?.classList.contains("drawer-toggle"),
    ),
    true,
  );
  await mp.getByRole("button", { name: "模型", exact: true }).click();
  await mp.getByRole("tab", { name: "我的模型", exact: true }).click();
  await mp.getByRole("button", { name: "添加连接", exact: true }).click();
  await mp.locator(".connection-form").waitFor();
  await mp.locator(".advanced-settings > summary").click();
  await mp.getByRole("combobox", { name: "接口协议", exact: true }).tap();
  await mobileDropdown.waitFor();
  const protocolTriggerBounds = (await mp
    .getByRole("combobox", { name: "接口协议", exact: true })
    .boundingBox())!;
  const protocolDropdownBounds = (await mobileDropdown.boundingBox())!;
  assert.ok(
    Math.abs(protocolTriggerBounds.x - protocolDropdownBounds.x) < 1,
    "手机协议列表紧邻触发框展开",
  );
  await mp.screenshot({
    path: "test-results/select-protocol-mobile.png",
    fullPage: true,
  });
  await mp.keyboard.press("Escape");
  await mobileDropdown.waitFor({ state: "hidden" });
  assert.equal(
    await mp.locator(".model-drawer.open").count(),
    1,
    "Escape 优先关闭下拉列表",
  );
  await mp.keyboard.press("Escape");
  await mp.locator(".model-drawer.open").waitFor({ state: "hidden" });
  assert.equal(
    await mp.evaluate(() =>
      document.activeElement?.classList.contains("drawer-toggle"),
    ),
    true,
  );
  await mp.getByRole("button", { name: "展开任务列表" }).click();
  await mp.locator(".task-row").first().locator(".task-more").click();
  const mobileTaskMenu = mp.locator(".task-menu:popover-open");
  await mobileTaskMenu.waitFor();
  await mp.waitForFunction(() =>
    document.querySelector('.task-more[aria-expanded="true"]'),
  );
  const mobileMenuBounds = (await mobileTaskMenu.boundingBox())!;
  assert.ok(mobileMenuBounds.x >= 8);
  assert.ok(mobileMenuBounds.x + mobileMenuBounds.width <= 382);
  assert.ok(mobileMenuBounds.y + mobileMenuBounds.height <= 836);
  await mp
    .getByRole("textbox", { name: "任务名称", exact: true })
    .fill("手机编辑");
  await mp.screenshot({
    path: "test-results/task-menu-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await mp.getByRole("textbox", { name: "搜索任务", exact: true }).tap();
  await mobileTaskMenu.waitFor({ state: "hidden" });
  await mp.getByRole("button", { name: "新建任务 新对话" }).click();
  await mp.locator(".welcome").waitFor();
  await mp.locator(".task-sidebar.open").waitFor({ state: "hidden" });
  await mp.getByRole("button", { name: "展开任务列表", exact: true }).tap();
  const mobileHelp = mp.locator(".help-panel:popover-open");
  await mp.getByRole("button", { name: "使用说明", exact: true }).tap();
  await mobileHelp.waitFor();
  const mobileHelpBounds = (await mobileHelp.boundingBox())!;
  assert.ok(
    mobileHelpBounds.x >= 8 &&
      mobileHelpBounds.x + mobileHelpBounds.width <= 382,
  );
  assert.ok(
    mobileHelpBounds.y >= 8 &&
      mobileHelpBounds.y + mobileHelpBounds.height <= 836,
  );
  await mp.screenshot({
    path: "test-results/help-hover-mobile.png",
    fullPage: true,
  });
  await mp.keyboard.press("Escape");
  await mobileHelp.waitFor({ state: "hidden" });
  assert.equal(
    await mp.locator(".task-sidebar.open").count(),
    1,
    "Escape 先关闭说明",
  );
  await mp.getByRole("button", { name: "使用说明", exact: true }).tap();
  await mobileHelp.waitFor();
  await mp.getByRole("textbox", { name: "搜索任务", exact: true }).tap();
  await mobileHelp.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: unified dropdowns, pointer focus styles, keyboard selection, Tab/Escape, popup positioning, mobile touch, task menus, connection discovery, model selection, single invocation, ordered image→video transfer, persistence, drawers and mobile layout.",
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
  fixture.closeAllConnections();
  fixture.close();
}
