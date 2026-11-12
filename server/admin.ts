import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { z } from "zod";
import * as store from "./store.ts";
import { adminKey, issueKey, revealKey, rotateKey } from "./key-management.ts";
import { keyUsage } from "./usage.ts";
import { languageModel } from "./providers.ts";
import { invokeMedia } from "./media.ts";
import { cancelOwnerRuns, cancelModelRuns } from "./engine.ts";
import { capabilities } from "./capabilities.ts";
import { assessInputs, inputDescription } from "./input-constraints.ts";
import type { CatalogModel } from "../shared/types.ts";

const modelInput = z.object({
  providerId: z.string(),
  modelId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  capabilities: z.array(z.string()).min(1).max(30),
  published: z.boolean().optional(),
});
function validateModel(body: z.infer<typeof modelInput>) {
  const p = store.provider(body.providerId),
    m = p?.models.find((m) => m.id === body.modelId);
  if (!p || !m) throw new Error("请先选择已接入连接中的模型。");
  if (body.capabilities.some((c) => !m.capabilities.includes(c)))
    throw new Error("所选能力尚未在连接模型中启用，请先在高级配置中调整。");
}
function validateGrants(ids: string[]) {
  if (ids.some((id) => !store.catalogModel(id)))
    throw new Error("授权列表中存在已移除的模型，请刷新后重试。");
}
export function invalidateProvider(providerId: string) {
  for (const m of store
    .catalogModels()
    .filter((m) => m.providerId === providerId)) {
    cancelModelRuns(m.id);
    store.putCatalogModel({
      ...m,
      published: false,
      testedAt: undefined,
      testedCapabilities: [],
    });
  }
}
const testing = new Set<string>();
export function adminRoutes(app: Express) {
  app.get("/api/admin/bootstrap", (_req, res) =>
    res.json({
      providers: store.providers(),
      models: store.catalogModels(),
      keys: store.accessKeys().map(adminKey),
      capabilities,
    }),
  );
  app.post("/api/admin/models", (req, res) => {
    const body = modelInput.parse(req.body);
    validateModel(body);
    if (body.published)
      throw new Error("请先保存草稿并测试能力，测试通过后才能上架。");
    const m: CatalogModel = {
      ...body,
      id: `mstar_${randomUUID()}`,
      published: false,
      testedCapabilities: [],
      createdAt: store.now(),
    };
    res.status(201).json(store.putCatalogModel(m));
  });
  app.patch("/api/admin/models/:id", (req, res) => {
    const old = store.catalogModel(String(req.params.id));
    if (!old) {
      res.status(404).json({ error: "模型不存在。" });
      return;
    }
    if (testing.has(old.id)) {
      res.status(409).json({ error: "模型正在测试，请等待测试结束。" });
      return;
    }
    const body = modelInput.partial().parse(req.body),
      next = { ...old, ...body };
    validateModel(next);
    const changed =
      next.providerId !== old.providerId ||
      next.modelId !== old.modelId ||
      next.capabilities.some((c) => !old.capabilities.includes(c));
    if (changed) {
      next.testedCapabilities = [];
      next.testedAt = undefined;
      next.published = false;
    }
    if (
      body.published &&
      (changed ||
        next.capabilities.some((c) => !next.testedCapabilities.includes(c)))
    )
      throw new Error("请先测试通过全部上架能力，再上架这个模型。");
    cancelModelRuns(old.id);
    res.json(store.putCatalogModel(next));
  });
  app.post("/api/admin/models/:id/test", async (req, res) => {
    const m = store.catalogModel(String(req.params.id));
    if (!m) {
      res.status(404).json({ error: "模型不存在。" });
      return;
    }
    const { capability, prompt, attachments } = z
      .object({
        capability: z.string(),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .default("请用一句话确认连接成功。"),
        attachments: z.array(z.string()).max(10).default([]),
      })
      .parse(req.body);
    if (!m.capabilities.includes(capability))
      throw new Error("此模型未配置该能力。");
    if (testing.size >= 3 || testing.has(m.id)) {
      res.status(409).json({ error: "已有连通测试正在进行，请稍后重试。" });
      return;
    }
    const p = store.provider(m.providerId);
    if (!p) throw new Error("上游连接已移除。");
    const originalKey = store.providerKey(p.id);
    const inputs = attachments.map((id) => {
      const f = store.file(id);
      if (!f) throw new Error("测试附件不存在，请重新上传。");
      return f;
    });
    const checkedInputs = assessInputs(
      p.models.find((model) => model.id === m.modelId)!,
      capability,
      prompt,
      inputs,
      p.customCapabilities,
    );
    if (
      checkedInputs.missing.length ||
      (!checkedInputs.prompt.trim() && !checkedInputs.files.length)
    )
      throw new Error(
        `请提供模型支持的测试输入${checkedInputs.missing.length ? `：${inputDescription(checkedInputs.missing)}` : ""}。`,
      );
    testing.add(m.id);
    try {
      const signal = AbortSignal.timeout(
        capability === "text" ? 45000 : 20 * 60 * 1000,
      );
      let text: string,
        output: import("../shared/types.ts").Attachment[] = [];
      if (capability === "text") {
        const result = await generateText({
          model: languageModel(p, m.modelId),
          prompt: checkedInputs.prompt,
          maxOutputTokens: 64,
          maxRetries: 0,
          abortSignal: signal,
        });
        text = result.text;
        if (!text.trim()) throw new Error("接口未返回有效文字，测试未通过。");
      } else {
        const result = await invokeMedia(
          p,
          m.modelId,
          capability,
          checkedInputs.prompt,
          checkedInputs.files,
          {},
          signal,
          () => {},
        );
        text = result.text;
        output = result.attachments;
        if (!text.trim() && !output.length)
          throw new Error("接口未返回有效结果，测试未通过。");
      }
      // Provider edits during an async test must not certify the newly changed configuration.
      if (
        JSON.stringify(store.provider(p.id)) !== JSON.stringify(p) ||
        store.providerKey(p.id) !== originalKey
      )
        throw new Error("测试期间连接配置已改变，请重新测试。");
      const latest = store.catalogModel(m.id)!;
      const updated = store.putCatalogModel({
        ...latest,
        testedAt: store.now(),
        testedCapabilities: [
          ...new Set([...latest.testedCapabilities, capability]),
        ],
      });
      res.json({
        model: updated,
        text: text.slice(0, 2000),
        attachments: output,
      });
    } catch (error) {
      const latest = store.catalogModel(m.id);
      if (latest)
        store.putCatalogModel({
          ...latest,
          published: false,
          testedCapabilities: latest.testedCapabilities.filter(
            (c) => c !== capability,
          ),
        });
      cancelModelRuns(m.id);
      throw error;
    } finally {
      testing.delete(m.id);
    }
  });
  app.delete("/api/admin/models/:id", (req, res) => {
    const id = String(req.params.id);
    if (testing.has(id)) throw new Error("测试结束后才能移除模型。");
    cancelModelRuns(id);
    store.db.prepare("DELETE FROM catalog WHERE id=?").run(id);
    for (const k of store.accessKeys())
      if (k.modelIds.includes(id))
        store.putAccessKey({
          ...k,
          modelIds: k.modelIds.filter((v) => v !== id),
        });
    res.json({ ok: true });
  });
  const keyInput = z.object({
    label: z.string().trim().min(1).max(100),
    modelIds: z.array(z.string()).max(500),
    enabled: z.boolean().default(true),
    expiresAt: z.iso.datetime().nullable().optional(),
  });
  app.post("/api/admin/keys", (req, res) => {
    const body = keyInput.parse(req.body);
    validateGrants(body.modelIds);
    const result = issueKey({
      ...body,
      expiresAt: body.expiresAt || undefined,
      modelIds: [...new Set(body.modelIds)],
    });
    res.status(201).json(result);
  });
  app.post("/api/admin/keys/:id/secret", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ secret: revealKey(String(req.params.id)) });
  });
  app.post("/api/admin/keys/:id/rotate", (req, res) => {
    const id = String(req.params.id);
    const result = rotateKey(id);
    cancelOwnerRuns(id);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });
  app.get("/api/admin/keys/:id/usage", (req, res) => {
    const filter = z
      .object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        modelId: z.string().max(300).optional(),
        status: z
          .enum(["running", "success", "error", "cancelled", "interrupted"])
          .optional(),
        page: z.coerce.number().int().min(1).max(1000000).default(1),
      })
      .parse(req.query);
    if (
      filter.from &&
      filter.to &&
      Date.parse(filter.from) >= Date.parse(filter.to)
    ) {
      res.status(400).json({ error: "开始时间必须早于结束时间。" });
      return;
    }
    res.json(
      keyUsage(String(req.params.id), {
        ...filter,
        from: filter.from ? new Date(filter.from).toISOString() : undefined,
        to: filter.to ? new Date(filter.to).toISOString() : undefined,
      }),
    );
  });
  app.patch("/api/admin/keys/:id", (req, res) => {
    const k = store.accessKey(String(req.params.id));
    if (!k) {
      res.status(404).json({ error: "密钥不存在。" });
      return;
    }
    const body = keyInput.partial().parse(req.body);
    if (body.modelIds) validateGrants(body.modelIds);
    const next = {
      ...k,
      ...body,
      expiresAt:
        body.expiresAt === null ? undefined : (body.expiresAt ?? k.expiresAt),
    };
    cancelOwnerRuns(k.id);
    if (!next.enabled)
      store.db.prepare("DELETE FROM sessions WHERE owner=?").run(k.id);
    res.json(adminKey(store.putAccessKey(next)));
  });
  app.delete("/api/admin/keys/:id", (req, res) => {
    const id = String(req.params.id);
    cancelOwnerRuns(id);
    store.db.prepare("DELETE FROM sessions WHERE owner=?").run(id);
    store.db.prepare("DELETE FROM access_keys WHERE id=?").run(id);
    res.json({ ok: true });
  });
}
