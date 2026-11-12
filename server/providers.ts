import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Provider, Protocol } from "../shared/types.ts";
import { inferModel } from "./capabilities.ts";
import { providerKey, currentOwner } from "./store.ts";
import { networkFetch, limitedJson } from "./network.ts";
import { acquireResource } from "./limits.ts";

export function normalizeUrl(input: string) {
  const u = new URL(input.trim());
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error(
      "请填写 http(s) API 基础地址，不要在地址中放 Key、查询参数或密码。",
    );
  let path = u.pathname
    .replace(/\/+$/, "")
    .replace(
      /\/(chat\/completions|responses|messages|models|images\/generations|videos|audio\/speech|embeddings)$/,
      "",
    );
  if (!path)
    path = /generativelanguage\.googleapis\.com/.test(u.hostname)
      ? "/v1beta"
      : /\.volces\.com$/.test(u.hostname)
        ? "/api/v3"
        : "/v1";
  return `${u.origin}${path}`;
}
export function detectProtocol(url: string): Protocol {
  if (/generativelanguage\.googleapis\.com|\/v1beta(?:\/|$)/.test(url))
    return "google";
  if (/api\.anthropic\.com|\/messages\/?$/.test(url)) return "anthropic";
  if (/api\.openai\.com|\/responses\/?$/.test(url)) return "openai";
  return "compatible";
}
export function vendorFor(url: string) {
  const host = new URL(url).hostname;
  return /(^|\.)volces\.com$/.test(host)
    ? "ark"
    : /(^|\.)api\.nvidia\.com$|^api\.nvcf\.nvidia\.com$/.test(host)
      ? "nvidia"
      : undefined;
}
export function headers(
  protocol: Protocol,
  key: string,
): Record<string, string> {
  if (protocol === "anthropic")
    return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (protocol === "google") return { "x-goog-api-key": key };
  return key ? { Authorization: `Bearer ${key}` } : {};
}
export function redact(text: string, key: string) {
  return key ? text.split(key).join("[已隐藏 Key]") : text;
}
export function managedOutput(
  p: Provider & { managed?: true; upstreamModelId?: string },
  text: string,
  secret?: string,
  complete = true,
) {
  if (!p.managed) return text;
  const values: [string, string][] = [
    [secret ?? providerKey(p.id), "[已隐藏凭据]"],
    [p.url, "[模型服务]"],
    [new URL(p.url).origin, "[模型服务]"],
  ];
  if (p.upstreamModelId && p.upstreamModelId.length >= 3)
    values.push([p.upstreamModelId, p.name]);
  // Do not publish a secret prefix while waiting for the remainder of a stream chunk.
  {
    let pending = 0;
    const minimum = complete ? 8 : 1;
    for (const [value] of values)
      for (
        let length = Math.min(value.length - 1, text.length);
        length >= minimum && length > pending;
        length--
      )
        if (text.endsWith(value.slice(0, length))) {
          pending = length;
          break;
        }
    if (pending)
      text = text.slice(0, -pending) + (complete ? "[已隐藏配置]" : "");
  }
  for (const [value, replacement] of values
    .filter(([v]) => v)
    .sort((a, b) => b[0].length - a[0].length))
    text = text.split(value).join(replacement);
  return text;
}
export function managedFileData(
  p: Provider & { managed?: true; upstreamModelId?: string },
  mime: string,
  data: Uint8Array,
  secret?: string,
) {
  if (
    !p.managed ||
    !/^(text\/|application\/(?:[a-z0-9.+-]*\+)?(?:json|xml))/i.test(mime)
  )
    return data;
  const raw = Buffer.from(data).toString("utf8");
  const mask = (value: string) => managedOutput(p, value, secret);
  if (/json/i.test(mime)) {
    try {
      const visit = (value: any): any =>
        typeof value === "string"
          ? mask(value)
          : Array.isArray(value)
            ? value.map(visit)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value).map(([k, v]) => [mask(k), visit(v)]),
                )
              : value;
      return Buffer.from(JSON.stringify(visit(JSON.parse(raw)), null, 2));
    } catch {}
  }
  return Buffer.from(mask(raw));
}
export async function errorFor(response: Response, key = "") {
  const raw = await response.text();
  let detail = raw;
  try {
    const j = JSON.parse(raw);
    detail = j.error?.message || j.message || JSON.stringify(j.error || j);
  } catch {}
  return new Error(
    redact(
      `API ${response.status}：${detail.slice(0, 700) || response.statusText}`,
      key,
    ),
  );
}
export async function discover(
  input: string,
  key: string,
  explicit?: Protocol,
) {
  const release = acquireResource("discovery", currentOwner());
  try {
    const url = normalizeUrl(input),
      protocol = explicit || detectProtocol(input);
    const endpointModel =
      new URL(url).hostname === "ai.api.nvidia.com"
        ? new URL(url).pathname.match(/^\/v1\/genai\/(.+)$/)?.[1]
        : undefined;
    if (endpointModel)
      return {
        url,
        protocol,
        models: [
          {
            ...inferModel({ id: endpointModel }, protocol),
            description: "从 NVIDIA 单模型端点解析；实际调用权限尚未验证。",
          },
        ],
      };
    const list: any[] = [];
    let next: string | undefined;
    for (let page = 0; page < 20; page++) {
      const query =
        protocol === "google"
          ? `?pageSize=1000${next ? `&pageToken=${encodeURIComponent(next)}` : ""}`
          : protocol === "anthropic"
            ? `?limit=1000${next ? `&after_id=${encodeURIComponent(next)}` : ""}`
            : "";
      const res = await networkFetch(`${url}/models${query}`, {
        headers: headers(protocol, key),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
      });
      if (!res.ok) throw await errorFor(res, key);
      const j = await limitedJson(res);
      const rows = j.data || j.models || (Array.isArray(j) ? j : []);
      if (!Array.isArray(rows))
        throw new Error("模型列表格式不正确，请核对接口地址。");
      list.push(...rows.slice(0, 5000 - list.length));
      next = j.nextPageToken || (j.has_more ? j.last_id : undefined);
      if (!next || list.length >= 5000) break;
    }
    const models = [
      ...new Map(
        list
          .filter((r) => r.status !== "Shutdown")
          .map((r) => {
            const m = inferModel(r, protocol);
            return [m.id, m];
          }),
      ).values(),
    ].filter((m) => m.id);
    if (!models.length)
      throw new Error(
        "连接成功，但服务没有返回模型列表。可展开高级设置，填写服务文档中的模型 ID。",
      );
    return { url, protocol, models };
  } finally {
    release();
  }
}
export function languageModel(
  p: Provider & { managed?: true; upstreamModelId?: string },
  modelId: string,
  extraBody: Record<string, unknown> = {},
) {
  modelId = p.upstreamModelId || modelId;
  const apiKey = providerKey(p.id);
  const reserved = [
    "model",
    "messages",
    "input",
    "system",
    "instructions",
    "systemInstruction",
    "contents",
    "tools",
    "tool_choice",
    "stream",
    "stream_options",
  ];
  const extra = Object.fromEntries(
    Object.entries(extraBody).filter(([k]) => !reserved.includes(k)),
  );
  const requestFetch: typeof fetch = (input, init) => {
    // Recheck current grants on every HTTP call, including SDK multi-step requests.
    providerKey(p.id);
    if (typeof init?.body === "string" && Object.keys(extra).length) {
      const body = JSON.parse(init.body);
      return networkFetch(
        input,
        {
          ...init,
          redirect: "error",
          body: JSON.stringify({ ...body, ...extra }),
        },
        !!p.managed,
      );
    }
    return networkFetch(input, { ...init, redirect: "error" }, !!p.managed);
  };
  const options = { baseURL: p.url, apiKey, fetch: requestFetch };
  if (p.protocol === "anthropic") return createAnthropic(options)(modelId);
  if (p.protocol === "google")
    return createGoogleGenerativeAI(options)(modelId);
  if (p.protocol === "openai") return createOpenAI(options).responses(modelId);
  return createOpenAICompatible({
    ...options,
    name: p.name,
    supportsStructuredOutputs: false,
  }).chatModel(modelId);
}
