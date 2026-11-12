import express from "express";
import multer from "multer";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HttpError, acquireResource } from "./limits.ts";
import * as store from "./store.ts";
import { capabilities, validateCustom, inferModel } from "./capabilities.ts";
import { discover, normalizeUrl, detectProtocol, redact } from "./providers.ts";
import {
  startRun,
  cancelRun,
  isRunning,
  events,
  answerInputConfirmation,
} from "./engine.ts";
import { inputConstraintsSchema } from "./input-constraints.ts";
import { authRoutes, requireAdmin, requireUser, identity } from "./auth.ts";
import { adminRoutes, invalidateProvider } from "./admin.ts";
import type {
  Provider,
  TaskSettings,
  CustomCapability,
} from "../shared/types.ts";
import { AUTO_CAPABILITY } from "../shared/types.ts";

const protocolSchema = z.enum(["compatible", "openai", "anthropic", "google"]);
const modelSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(300),
  capabilities: z.array(z.string().min(1).max(64)).min(1).max(30),
  source: z.enum(["metadata", "inferred", "manual"]),
  contextWindow: z.number().optional(),
  description: z.string().optional(),
  tools: z.boolean().optional(),
  inputConstraints: inputConstraintsSchema.optional(),
});
const settingsSchema = z.object({
  mode: z.enum(["direct", "team", "workflow"]),
  selections: z
    .array(
      z.object({
        providerId: z.string(),
        modelId: z.string(),
        role: z.string().max(2000),
      }),
    )
    .max(8),
  primary: z.string().optional(),
  capability: z.string().max(64),
  rounds: z
    .number()
    .int()
    .min(1)
    .max(3)
    .transform(() => 1),
  continuous: z
    .boolean()
    .optional()
    .transform(() => false),
  maxCalls: z.number().int().min(1).max(64),
  systemPrompt: z.string().max(20000),
  workflow: z
    .array(
      z.object({
        id: z.string().max(80),
        providerId: z.string(),
        modelId: z.string(),
        capability: z.string().max(64),
        prompt: z.string().max(20000),
        inputSource: z.enum(["previous", "original", "all"]),
        optionsJson: z.string().max(20000),
      }),
    )
    .max(12)
    .optional(),
});
const customSchema = z
  .array(
    z.object({
      id: z.string(),
      label: z.string().max(100),
      path: z.string().max(1000),
      method: z.enum(["GET", "POST"]).optional(),
      body: z.record(z.string(), z.unknown()).optional(),
      resultPath: z.string().optional(),
      output: z.enum(["text", "image", "video", "audio", "json"]).optional(),
      poll: z
        .object({
          path: z.string(),
          statusPath: z.string(),
          complete: z.string(),
          failed: z.string().optional(),
          resultPath: z.string(),
        })
        .optional(),
    }),
  )
  .max(30);
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (process.env.WORKBENCH_TRUST_PROXY) {
    const proxies = process.env.WORKBENCH_TRUST_PROXY.split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (
      !proxies.length ||
      proxies.some((v) => /^(true|false|\d+|0\.0\.0\.0\/0|::\/0)$/i.test(v))
    )
      throw new Error(
        "WORKBENCH_TRUST_PROXY 只能指定可信代理的 IP、CIDR 或 loopback，不能信任所有来源或仅按跳数信任。",
      );
    app.set("trust proxy", proxies);
  }
  app.use((req, res, next) => {
    let host = "";
    try {
      const requested = new URL(`http://${req.headers.host || ""}`);
      if (!requested.username && !requested.password) host = requested.hostname;
    } catch {}
    const configuredOrigin = process.env.WORKBENCH_ORIGIN;
    const allowedHost = configuredOrigin
      ? new URL(configuredOrigin).hostname
      : undefined;
    if (
      !["localhost", "127.0.0.1", "[::1]", "::1", allowedHost].includes(host)
    ) {
      res.status(403).json({ error: "仅允许本机访问。" });
      return;
    }
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://${req.headers.host}` &&
      origin !== `https://${req.headers.host}` &&
      origin !== configuredOrigin
    ) {
      res
        .status(403)
        .json({ error: "已拒绝跨站请求。请从本机工作台页面操作。" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (
      process.env.NODE_ENV === "production" ||
      process.argv.includes("--production")
    )
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "已拒绝跨站请求。" });
      return;
    }
    if (req.path.toLowerCase().startsWith("/api"))
      res.setHeader("Cache-Control", "no-store");
    const contentType = req.headers["content-type"] || "";
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !contentType.startsWith("application/json") &&
      !contentType.startsWith("multipart/form-data")
    ) {
      res.status(415).json({ error: "需要 JSON 或文件上传请求。" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "3mb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  authRoutes(app);
  // Use Express matching for both the guard and routes, including case variants.
  app.use("/api/admin", requireAdmin);
  app.use("/api", (req, res, next) => {
    if (res.locals.adminAuthenticated) next();
    else requireUser(req, res, next);
  });
  adminRoutes(app);
  app.get("/api/bootstrap", (_req, res) =>
    res.json({
      providers: store.workspaceProviders(),
      tasks: store.tasks(),
      capabilities: [...capabilities, ...store.publicCapabilities()],
    }),
  );
  app.post(
    ["/api/providers/discover", "/api/admin/providers/discover"],
    async (req, res) => {
      const body = z
        .object({
          url: z.string(),
          key: z.string().max(10000).default(""),
          protocol: protocolSchema.optional(),
        })
        .parse(req.body);
      res.json(await discover(body.url, body.key, body.protocol));
    },
  );
  app.post(["/api/providers", "/api/admin/providers"], async (req, res) => {
    const body = z
      .object({
        url: z.string(),
        key: z.string().max(10000).default(""),
        name: z.string().max(100).optional(),
        protocol: protocolSchema.optional(),
        manualIds: z.array(z.string().min(1).max(300)).max(200).optional(),
        customCapabilities: customSchema.optional(),
      })
      .parse(req.body);
    const url = normalizeUrl(body.url),
      protocol = body.protocol || detectProtocol(body.url);
    const custom = body.customCapabilities || [];
    validateCustom(custom);
    const result = body.manualIds?.length
      ? {
          url,
          protocol,
          models: body.manualIds.map((id) => ({
            ...inferModel({ id }, protocol),
            source: "manual" as const,
          })),
        }
      : await discover(url, body.key, protocol);
    const p: Provider = {
      ...result,
      id: randomUUID(),
      name: body.name?.trim() || new URL(url).hostname,
      hasKey: !!body.key,
      keyHint: body.key ? `••••${body.key.slice(-4)}` : "无需 Key",
      createdAt: store.now(),
      customCapabilities: custom,
    };
    store.putProvider(p, body.key);
    res.status(201).json(p);
  });
  app.patch(
    ["/api/providers/:id", "/api/admin/providers/:id"],
    async (req, res) => {
      const old = store.provider(String(req.params.id));
      if (!old) {
        res.status(404).json({ error: "连接不存在。" });
        return;
      }
      if (
        store
          .tasks()
          .some(
            (t) =>
              t.running &&
              t.settings.selections.some((s) => s.providerId === old.id),
          )
      ) {
        res
          .status(409)
          .json({ error: "正在使用这个连接，请停止相关任务后再修改。" });
        return;
      }
      const body = z
        .object({
          name: z.string().min(1).max(100).optional(),
          url: z.string().optional(),
          key: z.string().max(10000).optional(),
          protocol: protocolSchema.optional(),
          models: z.array(modelSchema).max(5000).optional(),
          manualIds: z.array(z.string().min(1).max(300)).max(200).optional(),
          refresh: z.boolean().optional(),
          customCapabilities: customSchema.optional(),
        })
        .parse(req.body);
      const custom = body.customCapabilities || old.customCapabilities;
      validateCustom(custom);
      let p = {
        ...old,
        ...body,
        url: body.url ? normalizeUrl(body.url) : old.url,
        customCapabilities: custom,
      } as Provider;
      if (body.manualIds?.length)
        p.models = [
          ...p.models,
          ...body.manualIds
            .filter((id) => !p.models.some((m) => m.id === id))
            .map((id) => inferModel({ id }, p.protocol)),
        ];
      if (p.models.length > 5000)
        throw new Error("一个连接最多保留 5000 个模型。");
      if (body.refresh) {
        const found = await discover(
          p.url,
          body.key ?? store.providerKey(p.id),
          p.protocol,
        );
        p.models = found.models.map((m) => {
          const prev = old.models.find((x) => x.id === m.id);
          return prev?.source === "manual" ? prev : m;
        });
      }
      if (body.key !== undefined) {
        p.hasKey = !!body.key;
        p.keyHint = body.key ? `••••${body.key.slice(-4)}` : "无需 Key";
      }
      // Never serialize the submitted key into the public provider record.
      const safe: Provider = {
        id: p.id,
        name: p.name,
        url: p.url,
        protocol: p.protocol,
        models: p.models,
        hasKey: p.hasKey,
        keyHint: p.keyHint,
        createdAt: p.createdAt,
        customCapabilities: custom,
      };
      if (store.currentOwner() === store.PLATFORM_OWNER)
        invalidateProvider(old.id);
      store.putProvider(safe, body.key);
      res.json(safe);
    },
  );
  app.delete(["/api/providers/:id", "/api/admin/providers/:id"], (req, res) => {
    const id = String(req.params.id);
    if (
      store
        .tasks()
        .some(
          (t) =>
            t.running && t.settings.selections.some((s) => s.providerId === id),
        )
    ) {
      res.status(409).json({ error: "正在使用这个连接，请先停止相关任务。" });
      return;
    }
    if (store.currentOwner() === store.PLATFORM_OWNER) invalidateProvider(id);
    store.deleteProvider(id);
    for (const t of store.tasks())
      store.putTask({
        ...t,
        settings: {
          ...t.settings,
          selections: t.settings.selections.filter((s) => s.providerId !== id),
        },
      });
    res.json({ ok: true });
  });
  app.post("/api/tasks", (req, res) => {
    const { title } = z
      .object({ title: z.string().max(100).optional() })
      .parse(req.body);
    res.status(201).json(store.createTask(title));
  });
  app.get("/api/tasks/:id", (req, res) => {
    const t = store.task(String(req.params.id));
    if (!t) {
      res.status(404).json({ error: "任务不存在。" });
      return;
    }
    res.json({ ...t, messages: store.messages(t.id) });
  });
  app.patch("/api/tasks/:id", (req, res) => {
    const t = store.task(String(req.params.id));
    if (!t) {
      res.status(404).json({ error: "任务不存在。" });
      return;
    }
    const body = z
      .object({
        title: z.string().min(1).max(100).optional(),
        settings: settingsSchema.optional(),
      })
      .parse(req.body);
    const switchingTeam =
      body.settings &&
      t.settings.mode === "team" &&
      body.settings.mode !== "team";
    if (body.settings && isRunning(t.id) && !switchingTeam) {
      res.status(409).json({ error: "任务正在运行，结束后可切换模型或设置。" });
      return;
    }
    if (
      body.settings &&
      new Set(
        body.settings.selections.map((s) => `${s.providerId}::${s.modelId}`),
      ).size !== body.settings.selections.length
    )
      throw new Error("同一模型不能重复加入任务。");
    if (switchingTeam && isRunning(t.id)) cancelRun(t.id);
    if (body.settings)
      for (const s of body.settings.selections) {
        // Existing unavailable members may be removed one at a time; only additions need catalog access.
        if (
          t.settings.selections.some(
            (old) =>
              old.providerId === s.providerId && old.modelId === s.modelId,
          )
        )
          continue;
        const p = store.runtimeProvider(s.providerId);
        if (!p?.models.some((m) => m.id === s.modelId))
          throw new Error("所选模型不存在或没有使用权限，请刷新模型列表。");
      }
    res.json(store.putTask({ ...t, ...body, updatedAt: store.now() }));
  });
  app.delete("/api/tasks/:id", (req, res) => {
    const id = String(req.params.id);
    if (!store.task(id)) {
      res.status(404).json({ error: "任务不存在。" });
      return;
    }
    if (isRunning(id)) {
      res.status(409).json({ error: "请先停止运行再删除任务。" });
      return;
    }
    store.deleteTask(id);
    res.json({ ok: true });
  });
  app.post("/api/tasks/:id/run", (req, res) => {
    const t = store.task(String(req.params.id));
    if (!t) {
      res.status(404).json({ error: "任务不存在。" });
      return;
    }
    const body = z
      .object({
        content: z.string().max(100000),
        attachments: z.array(z.string()).max(10).default([]),
        options: z.record(z.string(), z.unknown()).optional(),
        autoCapabilities: z.boolean().default(false),
      })
      .parse(req.body);
    if (!body.content.trim() && !body.attachments.length)
      throw new Error("请填写消息或上传文件。");
    const attachments = body.attachments.map((id) => {
      const a = store.file(id);
      if (!a) throw new Error("附件不存在，请重新上传。");
      return a;
    });
    res.status(202).json(
      startRun(
        body.autoCapabilities
          ? {
              ...t,
              settings: {
                ...t.settings,
                capability: AUTO_CAPABILITY,
                workflow: t.settings.workflow?.map((step) => ({
                  ...step,
                  capability: AUTO_CAPABILITY,
                })),
              },
            }
          : t,
        body.content.trim(),
        attachments,
        body.options,
      ),
    );
  });
  app.post("/api/tasks/:id/confirmations/:messageId", (req, res) => {
    const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    res.json(
      answerInputConfirmation(
        String(req.params.id),
        String(req.params.messageId),
        accept,
      ),
    );
  });
  app.post("/api/tasks/:id/stop", (req, res) => {
    const id = String(req.params.id);
    if (!store.task(id)) {
      res.status(404).json({ error: "任务不存在。" });
      return;
    }
    res.json({ stopped: cancelRun(id) });
  });
  app.get("/api/tasks/:id/events", (req, res) => {
    const id = String(req.params.id);
    if (!store.task(id)) {
      res.status(404).end();
      return;
    }
    const release = acquireResource("stream", store.currentOwner());
    res.once("close", release);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const send = (event: { type: string; data: unknown }) =>
      !res.writableEnded && identity(req)
        ? res.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
          )
        : res.end();
    // Snapshot closes the initial fetch/subscribe gap and restores state on reconnect.
    send({
      type: "snapshot",
      data: { ...store.task(id), messages: store.messages(id) },
    });
    events.on(id, send);
    const heartbeat = setInterval(
      () => (identity(req) ? res.write(": heartbeat\n\n") : res.end()),
      15000,
    );
    heartbeat.unref();
    req.on("close", () => {
      clearInterval(heartbeat);
      events.off(id, send);
    });
  });
  const uploadDir = join(store.dataDir, "uploads-tmp");
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, _file, cb) => cb(null, randomUUID()),
    }),
    limits: {
      fileSize: 40 * 1024 * 1024,
      files: 10,
      fields: 10,
      parts: 20,
      fieldSize: 1024 * 1024,
    },
  });
  app.post(
    ["/api/files", "/api/admin/files"],
    (_req, res, next) => {
      const release = acquireResource("upload", store.currentOwner());
      res.once("finish", release);
      res.once("close", release);
      next();
    },
    upload.array("files", 10),
    (req, res) => {
      const files = req.files as Express.Multer.File[];
      if (!files?.length) throw new Error("没有选择文件。");
      const saved: import("../shared/types.ts").Attachment[] = [];
      try {
        store.assertStorageCapacity(
          files.reduce((sum, f) => sum + f.size, 0),
          false,
        );
        for (const f of files)
          saved.push(
            store.saveFile(
              Buffer.from(f.originalname, "latin1").toString("utf8"),
              f.mimetype,
              readFileSync(f.path),
            ),
          );
        res.status(201).json(saved);
      } catch (error) {
        for (const f of saved) store.deleteFile(f.id);
        throw error;
      } finally {
        for (const f of files) if (existsSync(f.path)) unlinkSync(f.path);
      }
    },
  );
  app.get(["/api/files/:id", "/api/admin/files/:id"], (req, res) => {
    const a = store.file(String(req.params.id));
    if (!a) {
      res.status(404).end();
      return;
    }
    const inline =
      /^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm)|audio\/[a-z0-9.+-]+)$/.test(
        a.mime,
      );
    res.setHeader("Content-Type", inline ? a.mime : "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `${inline && !req.query.download ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    );
    // Resolve the opaque filename relative to filesDir. Passing the absolute
    // .data/files/... path makes sendFile treat .data as a hidden file segment.
    res.sendFile(a.id, { root: store.filesDir, dotfiles: "deny" }, (error) => {
      if (!error) return;
      if (res.headersSent || req.aborted) {
        res.destroy();
        return;
      }
      const failure = error as Error & {
        status?: number;
        statusCode?: number;
        headers?: Record<string, string>;
      };
      const status = failure.statusCode || failure.status || 500;
      res.removeHeader("Content-Disposition");
      res.removeHeader("Content-Type");
      res.removeHeader("Content-Length");
      if (failure.headers) res.set(failure.headers);
      res.status(status).json({
        error:
          status === 404
            ? "本地附件文件不存在，请检查文件是否被移动或删除。"
            : status === 416
              ? "请求的文件范围无效。"
              : "读取本地附件失败，请稍后重试。",
      });
    });
  });
  app.get("/api/tasks/:id/export", (req, res) => {
    const t = store.task(String(req.params.id));
    if (!t) {
      res.status(404).end();
      return;
    }
    const messages = store.messages(t.id);
    const json = req.query.format === "json";
    const text = json
      ? JSON.stringify({ ...t, messages }, null, 2)
      : `# ${t.title}\n\n${messages.map((m) => `## ${m.role === "user" ? "用户" : m.model || (m.role === "activity" ? "协作记录" : "系统")}${m.stage ? ` · ${m.stage}` : ""}\n\n${m.content}\n\n${m.attachments.map((a) => `[${a.name}](${a.url})`).join("\n")}`).join("\n\n")}`;
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(t.title)}.${json ? "json" : "md"}`,
    );
    res.type(json ? "application/json" : "text/markdown").send(text);
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "接口不存在。" }),
  );
  app.use(
    (
      error: any,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      let message =
        error instanceof z.ZodError
          ? `配置格式有误：${error.issues
              .map((i) => `${i.path.join(".")} ${i.message}`)
              .slice(0, 3)
              .join("；")}`
          : error.code === "LIMIT_FILE_SIZE"
            ? "文件超过 40 MB，请缩小后重新上传。"
            : error.message || "操作失败，请重试。";
      for (const p of store.hasOwnerContext() ? store.providers() : [])
        message = redact(message, store.providerKey(p.id));
      if (typeof req.body?.key === "string")
        message = redact(message, req.body.key);
      res
        .status(error instanceof HttpError ? error.status : 400)
        .json({ error: message.slice(0, 1500) });
    },
  );
  return app;
}
