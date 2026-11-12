import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import express from "express";
import { chromium } from "playwright";

process.env.WORKBENCH_DATA = mkdtempSync(join(tmpdir(), "mstar-key-ui-"));
process.env.NODE_ENV = "production";
const store = await import("../server/store.ts");
const { createApp } = await import("../server/app.ts");
const { setupCode } = await import("../server/auth.ts");
const keys = await import("../server/key-management.ts");
const usage = await import("../server/usage.ts");
const modelId = "mstar_browser-text";
const issued = store.withOwner(store.PLATFORM_OWNER, () => {
  store.putCatalogModel({
    id: modelId,
    name: "文字助手",
    providerId: "fixture",
    modelId: "fixture-text",
    capabilities: ["text"],
    published: true,
    testedCapabilities: ["text"],
    createdAt: store.now(),
  });
  return keys.issueKey({
    label: "客户 A · 产品团队",
    modelIds: [modelId],
    enabled: true,
  });
});
store.withOwner(issued.key.id, () => {
  for (let i = 0; i < 3; i++) {
    const id = usage.startModelRequest(
      modelId,
      "text",
      "fixture-task",
      "fixture-message",
    );
    usage.finishModelRequest(
      id,
      i === 2 ? "error" : "success",
      i === 2 ? {} : { inputTokens: 120, outputTokens: 80 },
    );
  }
});
const app = createApp();
app.use(express.static(resolve("dist")));
app.use((_req, res) => res.sendFile(resolve("dist/index.html")));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
mkdirSync("test-results", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const setup = await context.request.post(base + "/api/auth/setup", {
    data: { code: setupCode(), password: "local-fixture-password-123" },
  });
  assert.equal(setup.status(), 200);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/admin");
  await page.getByRole("button", { name: "分发密钥", exact: true }).click();
  await page.getByRole("button", { name: /客户 A/ }).click();
  if (process.env.FEATURE_BASELINE) {
    await page.screenshot({
      path: "test-results/admin-keys-before-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/admin-keys-before-mobile.png",
      fullPage: true,
    });
  } else {
    assert.equal(
      await page.getByText(issued.secret, { exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "查看完整密钥", exact: true })
      .click();
    await page.getByText(issued.secret, { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "复制完整密钥", exact: true })
      .click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      issued.secret,
    );
    await page.getByRole("button", { name: "隐藏密钥", exact: true }).click();
    assert.equal(
      await page.getByText(issued.secret, { exact: true }).count(),
      0,
    );
    await page.getByRole("button", { name: "请求与用量", exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "查看完整密钥", exact: true })
        .count(),
      0,
      "Usage view keeps credential actions in authorization settings",
    );
    await page
      .getByRole("region", { name: "密钥请求与用量" })
      .getByText("240", { exact: true })
      .first()
      .waitFor();
    assert.equal(
      await page.locator(".key-extra-filters").getAttribute("open"),
      null,
    );
    assert.equal(
      await page.locator(".key-request-toggle").getAttribute("aria-expanded"),
      "false",
    );
    await page.screenshot({
      path: "test-results/admin-keys-usage-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "test-results/admin-keys-usage-mobile.png",
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.locator(".key-request-toggle").click();
    await page
      .getByRole("region", { name: "请求明细，可横向滚动" })
      .getByRole("table")
      .waitFor();
    await page.locator(".key-extra-filters > summary").click();
    await page.getByRole("combobox", { name: "请求状态", exact: true }).click();
    await page.getByRole("option", { name: "失败", exact: true }).click();
    await page.getByText("共 1 次请求", { exact: false }).waitFor();
    await page.getByRole("button", { name: "重置筛选", exact: true }).click();
    await page
      .getByRole("region", { name: "密钥请求与用量" })
      .getByText("240", { exact: true })
      .first()
      .waitFor();
    assert.equal(
      await page.locator(".key-request-toggle").getAttribute("aria-expanded"),
      "true",
      "Request details stay open when filters change",
    );
    await page
      .getByRole("combobox", { name: "用量时间范围", exact: true })
      .click();
    await page.getByRole("option", { name: "全部时间", exact: true }).click();
    await page
      .getByRole("region", { name: "密钥请求与用量" })
      .getByText("240", { exact: true })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "授权设置", exact: true }).click();
    await page
      .getByRole("button", { name: "重新生成密钥", exact: true })
      .click();
    await page.getByText(/旧密钥将立即失效/).waitFor();
    await page
      .getByRole("button", { name: "取消重新生成", exact: true })
      .click();
    const stillValid = await context.request.post(base + "/api/auth/login", {
      data: { key: issued.secret },
    });
    assert.equal(stillValid.status(), 200);
    await page
      .getByRole("button", { name: "关闭密钥配置", exact: true })
      .click();
    assert.equal(await page.locator(".key-secret-value").count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log(
    process.env.FEATURE_BASELINE
      ? "Captured existing key management on desktop/mobile"
      : "Admin key reveal, copy, hide, usage, mobile layout, rotation cancellation and secret cleanup passed.",
  );
  await context.close();
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
  store.db.close();
}
