import express from "express";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createApp } from "./app.ts";
import { setupCode, needsSetup } from "./auth.ts";
import { dataDir } from "./store.ts";
const production = process.argv.includes("--production");
const port = Number(process.env.PORT || 3210);
const host = process.env.WORKBENCH_HOST || "127.0.0.1";
if (!production && !["127.0.0.1", "localhost", "::1"].includes(host))
  throw new Error(
    "开发模式仅允许本机监听。对外部署请先构建，再使用 npm start。",
  );
const app = createApp();
if (production) {
  if (!existsSync(resolve("dist/index.html"))) {
    console.error("请先运行 npm run build");
    process.exit(1);
  }
  app.use(express.static(resolve("dist")));
  app.use((_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !process.env.WORKBENCH_ORIGIN?.startsWith("https://")
)
  throw new Error(
    "对外部署需要配置 HTTPS 的 WORKBENCH_ORIGIN，并通过反向代理访问。",
  );
const server = app.listen(port, host, () => {
  console.log(
    `\nMstar 工作台：http://127.0.0.1:${port}\n管理员后台：http://127.0.0.1:${port}/admin\n数据目录：${dataDir}\n`,
  );
  if (needsSetup())
    console.log(
      `首次初始化码：${setupCode()}\n请在管理员后台设置密码；初始化后此码自动失效。\n`,
    );
});
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
