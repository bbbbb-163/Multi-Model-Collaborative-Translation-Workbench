import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Provider,
  Attachment,
  CustomCapability,
  TokenUsage,
} from "../shared/types.ts";
import { providerKey, filesDir, saveFile as persistFile } from "./store.ts";
import {
  headers,
  errorFor,
  vendorFor,
  managedOutput,
  managedFileData,
} from "./providers.ts";
import { networkFetch } from "./network.ts";
import { usageFromResponse } from "./usage.ts";

interface Result {
  text: string;
  attachments: Attachment[];
}
function pcmToWav(data: Buffer, sampleRate: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const pointer = (value: any, path = "") =>
  path ? path.split(".").reduce((a: any, p: string) => a?.[p], value) : value;
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
function template(value: unknown, vars: Record<string, unknown>): any {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{(\w+)\}\}$/);
    if (exact) return vars[exact[1]] ?? "";
    return value.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
  }
  if (Array.isArray(value)) return value.map((v) => template(v, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, template(v, vars)]),
    );
  return value;
}
export async function invokeMedia(
  p: Provider & { managed?: true; upstreamModelId?: string },
  model: string,
  capability: string,
  prompt: string,
  inputs: Attachment[],
  requestedOptions: Record<string, any>,
  signal: AbortSignal,
  progress: (text: string) => void,
  recordUsage?: (usage: TokenUsage) => void,
): Promise<Result> {
  const saveFile = (name: string, mime: string, data: Uint8Array) =>
    persistFile(managedOutput(p, name), mime, managedFileData(p, mime, data));
  const displayName = p.managed ? p.name : model;
  if (p.managed) {
    const notify = progress;
    progress = () => notify("模型正在生成，请稍候…");
  }
  const options = Object.fromEntries(
    Object.entries(requestedOptions).filter(
      ([k]) =>
        ![
          "model",
          "prompt",
          "input",
          "content",
          "contents",
          "instances",
          "file",
        ].includes(k),
    ),
  );
  const key = providerKey(p.id),
    auth = headers(p.protocol, key),
    vendor = vendorFor(p.url);
  const request = async (path: string, body?: unknown, method = "POST") => {
    signal.throwIfAborted();
    providerKey(p.id);
    let res = await networkFetch(
      `${p.url}${path}`,
      {
        method,
        headers: {
          ...auth,
          ...(vendor === "nvidia" ? { "NVCF-POLL-SECONDS": "60" } : {}),
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          method === "GET"
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
        signal,
        redirect: "error",
      },
      !!p.managed,
    );
    if (vendor === "nvidia" && res.status === 202) {
      const pending: any = await res
        .clone()
        .json()
        .catch(() => ({}));
      const id =
        res.headers.get("nvcf-reqid") || pending.reqId || pending.requestId;
      if (!id)
        throw new Error("NVIDIA 返回了 202，但缺少可查询的 request ID。");
      const deadline = Date.now() + 20 * 60 * 1000;
      while (res.status === 202) {
        progress(`NVIDIA 正在排队或执行 · ${id}`);
        if (Date.now() > deadline)
          throw new Error(`NVIDIA 生成超时，request ID：${id}`);
        await res.body?.cancel();
        await wait(1500, signal);
        providerKey(p.id);
        res = await networkFetch(
          `https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/${encodeURIComponent(id)}`,
          {
            headers: { ...auth, "NVCF-POLL-SECONDS": "60" },
            signal,
            redirect: "error",
          },
          !!p.managed,
        );
      }
    }
    if (!res.ok) throw await errorFor(res, key);
    if (recordUsage) {
      // Observe JSON only when the adapter already consumes it. Do not clone
      // or buffer media payloads just for accounting, or count polling as calls.
      const readJSON = res.json.bind(res);
      res.json = async () => {
        const value: any = await readJSON();
        const usage = usageFromResponse(value);
        if (Object.values(usage).some((v) => v !== undefined))
          recordUsage(usage);
        return value;
      };
    }
    return res;
  };
  const persistOutput = async (
    value: any,
    kind: string,
    name: string,
  ): Promise<Attachment[]> => {
    name = p.managed ? displayName : name;
    if (!value) return [];
    const rows = Array.isArray(value) ? value : [value];
    return Promise.all(
      rows.map(async (item: any, i) => {
        const b64 =
          item.b64_json ||
          item.base64 ||
          item.bytesBase64Encoded ||
          item.inlineData?.data;
        const mime: string =
          item.mimeType ||
          item.inlineData?.mimeType ||
          (kind === "image"
            ? "image/png"
            : kind === "video"
              ? "video/mp4"
              : "audio/mpeg");
        if (b64) {
          const bytes = Buffer.from(b64, "base64");
          if (/audio\/(L16|pcm)/i.test(mime))
            return saveFile(
              `${name}-${i + 1}.wav`,
              "audio/wav",
              pcmToWav(bytes, Number(mime.match(/rate=(\d+)/)?.[1] || 24000)),
            );
          return saveFile(
            `${name}-${i + 1}.${mime.split("/")[1].split(";")[0].replace("mpeg", "mp3")}`,
            mime.split(";")[0],
            bytes,
          );
        }
        const url =
          typeof item === "string"
            ? item
            : item.url || item.uri || item.video?.uri;
        if (url?.startsWith("data:")) {
          const match = url.match(/^data:([^;]+);base64,(.*)$/s);
          if (match)
            return saveFile(
              `${name}-${i + 1}.${match[1].split("/")[1]}`,
              match[1],
              Buffer.from(match[2], "base64"),
            );
        }
        if (!url || !/^https?:\/\//.test(url))
          throw new Error(
            "接口没有返回可读取的媒体内容，请检查能力的结果路径。",
          );
        // Only send a provider key to that exact origin. Media CDNs receive no credentials.
        const sameOrigin = new URL(url).origin === new URL(p.url).origin;
        const res = await networkFetch(
          url,
          {
            headers: sameOrigin ? auth : {},
            signal,
            redirect: sameOrigin ? "error" : "follow",
          },
          !!p.managed && sameOrigin,
        );
        if (!res.ok) throw await errorFor(res, key);
        const bytes = await limitedBody(res, 200 * 1024 * 1024);
        const actual = res.headers.get("content-type")?.split(";")[0] || mime;
        return saveFile(
          `${name}-${i + 1}.${actual.split("/")[1]?.replace("mpeg", "mp3") || "bin"}`,
          actual,
          bytes,
        );
      }),
    );
  };
  const custom = p.customCapabilities.find((c) => c.id === capability);
  if (custom) {
    const files = inputs.map((a) => ({
      name: a.name,
      mime: a.mime,
      base64: readFileSync(join(filesDir, a.id)).toString("base64"),
    }));
    const vars = {
      ...options,
      model,
      prompt,
      files,
      image_base64:
        files.find((a) => a.mime.startsWith("image/"))?.base64 || "",
      audio_base64:
        files.find((a) => a.mime.startsWith("audio/"))?.base64 || "",
      video_base64:
        files.find((a) => a.mime.startsWith("video/"))?.base64 || "",
    };
    let j: any = await (
      await request(
        custom.path,
        template(
          custom.body || { model: "{{model}}", prompt: "{{prompt}}" },
          vars,
        ),
        custom.method,
      )
    ).json();
    if (custom.poll) {
      const id = String(j.id || j.name || "");
      if (!id) throw new Error("异步接口没有返回 id/name。");
      const deadline = Date.now() + 20 * 60 * 1000;
      while (pointer(j, custom.poll.statusPath) !== custom.poll.complete) {
        const state = pointer(j, custom.poll.statusPath);
        progress(`生成中 · ${state || "等待服务返回状态"}`);
        if (state === (custom.poll.failed || "failed"))
          throw new Error(
            `生成失败：${JSON.stringify(j.error || j).slice(0, 700)}`,
          );
        if (Date.now() > deadline)
          throw new Error(`生成超时，远端任务 ID：${id}`);
        await wait(3000, signal);
        j = await (
          await request(
            custom.poll.path.replace("{{id}}", encodeURIComponent(id)),
            undefined,
            "GET",
          )
        ).json();
      }
    }
    const output = pointer(j, custom.poll?.resultPath || custom.resultPath);
    if (output === undefined || output === null)
      throw new Error(
        "接口没有返回配置的结果字段，请核对高级配置中的结果路径。",
      );
    if (["image", "video", "audio"].includes(custom.output || ""))
      return {
        text: "",
        attachments: await persistOutput(output, custom.output!, model),
      };
    const text =
      typeof output === "string" ? output : JSON.stringify(output, null, 2);
    return {
      text: managedOutput(p, text || "接口未返回内容"),
      attachments:
        custom.output === "json"
          ? [
              saveFile(
                `${displayName}.json`,
                "application/json",
                Buffer.from(text || "null"),
              ),
            ]
          : [],
    };
  }
  if (p.protocol === "google") {
    if (
      (capability === "image" && !/imagen/i.test(model)) ||
      capability === "speech" ||
      capability === "transcription"
    ) {
      const relevant = inputs.filter((a) =>
        capability === "image"
          ? a.mime.startsWith("image/")
          : capability === "transcription"
            ? a.mime.startsWith("audio/") || a.mime.startsWith("video/")
            : false,
      );
      if (capability === "transcription" && !relevant.length)
        throw new Error("请先上传需要转写的音频或视频文件。");
      const parts = [
        { text: prompt || "请转写输入音频。" },
        ...relevant.map((a) => ({
          inlineData: {
            mimeType: a.mime,
            data: readFileSync(join(filesDir, a.id)).toString("base64"),
          },
        })),
      ];
      const config = {
        responseModalities:
          capability === "image"
            ? ["TEXT", "IMAGE"]
            : capability === "speech"
              ? ["AUDIO"]
              : ["TEXT"],
        ...options,
      };
      const j: any = await (
        await request(`/models/${encodeURIComponent(model)}:generateContent`, {
          contents: [{ role: "user", parts }],
          generationConfig: config,
        })
      ).json();
      const output =
        j.candidates?.flatMap((c: any) => c.content?.parts || []) || [];
      const media = output.filter((part: any) => part.inlineData);
      const text = output
        .filter((part: any) => part.text)
        .map((part: any) => part.text)
        .join("\n");
      if (!text && !media.length)
        throw new Error(
          `模型没有返回内容：${j.promptFeedback?.blockReason || "请确认模型支持该输出能力。"}`,
        );
      return {
        text: managedOutput(p, text),
        attachments: await persistOutput(
          media,
          capability === "image" ? "image" : "audio",
          model,
        ),
      };
    }
    if (capability === "image") {
      const j: any = await (
        await request(`/models/${encodeURIComponent(model)}:predict`, {
          instances: [{ prompt }],
          parameters: { sampleCount: 1, ...options },
        })
      ).json();
      return {
        text: "",
        attachments: await persistOutput(j.predictions, "image", model),
      };
    }
    if (capability === "embedding") {
      const j = await (
        await request(`/models/${encodeURIComponent(model)}:embedContent`, {
          model: `models/${model}`,
          content: { parts: [{ text: prompt }] },
        })
      ).json();
      return {
        text: "向量已计算，完整结果见文件。",
        attachments: [
          saveFile(
            `${displayName}.json`,
            "application/json",
            Buffer.from(
              JSON.stringify(
                p.managed ? j.embedding || j.embeddings || j : j,
                null,
                2,
              ),
            ),
          ),
        ],
      };
    }
    if (capability === "video") {
      const image = inputs.find((a) => a.mime.startsWith("image/"));
      let j: any = await (
        await request(
          `/models/${encodeURIComponent(model)}:predictLongRunning`,
          {
            instances: [
              {
                ...(prompt ? { prompt } : {}),
                ...(image
                  ? {
                      image: {
                        bytesBase64Encoded: readFileSync(
                          join(filesDir, image.id),
                        ).toString("base64"),
                        mimeType: image.mime,
                      },
                    }
                  : {}),
              },
            ],
            parameters: options,
          },
        )
      ).json();
      const operation = j.name;
      if (!operation) throw new Error("视频接口未返回操作 ID。");
      const deadline = Date.now() + 20 * 60 * 1000;
      while (!j.done) {
        if (Date.now() > deadline)
          throw new Error(`视频生成超时：${operation}`);
        progress("视频正在生成");
        await wait(5000, signal);
        j = await (await request(`/${operation}`, undefined, "GET")).json();
      }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return {
        text: "",
        attachments: await persistOutput(
          j.response?.generateVideoResponse?.generatedSamples?.map(
            (v: any) => v.video,
          ) || j.response?.videos,
          "video",
          model,
        ),
      };
    }
    throw new Error("该 Gemini 能力需要使用自定义能力定义接入服务对应的接口。");
  }
  if (p.protocol === "anthropic")
    throw new Error(
      "Anthropic Messages 接口仅支持文本/视觉对话。其他能力请使用对应服务连接。",
    );
  if (vendor === "ark" && capability === "video") {
    const content: any[] = prompt ? [{ type: "text", text: prompt }] : [];
    for (const a of inputs.filter((a) => a.mime.startsWith("image/")))
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${a.mime};base64,${readFileSync(join(filesDir, a.id)).toString("base64")}`,
        },
        role: content.length === 1 ? "first_frame" : "last_frame",
      });
    for (const a of inputs.filter(
      (a) => a.mime.startsWith("video/") || a.mime.startsWith("audio/"),
    )) {
      const kind = a.mime.startsWith("video/") ? "video" : "audio";
      content.push({
        type: `${kind}_url`,
        [`${kind}_url`]: {
          url: `data:${a.mime};base64,${readFileSync(join(filesDir, a.id)).toString("base64")}`,
        },
        role: kind === "video" ? "reference_video" : "reference_audio",
      });
    }
    let j: any = await (
      await request("/contents/generations/tasks", {
        model,
        content,
        ...options,
      })
    ).json();
    const id = j.id;
    if (!id) throw new Error("方舟视频接口未返回任务 ID。");
    const deadline = Date.now() + 20 * 60 * 1000;
    while (j.status !== "succeeded") {
      if (["failed", "cancelled", "expired"].includes(j.status))
        throw new Error(j.error?.message || `方舟任务 ${j.status}`);
      if (Date.now() > deadline)
        throw new Error(`方舟视频超时，任务 ID：${id}`);
      progress(`方舟视频生成中 · ${j.status || "queued"} · ${id}`);
      await wait(4000, signal);
      j = await (
        await request(
          `/contents/generations/tasks/${encodeURIComponent(id)}`,
          undefined,
          "GET",
        )
      ).json();
    }
    return {
      text: "",
      attachments: await persistOutput(j.content?.video_url, "video", model),
    };
  }
  if (vendor === "nvidia" && capability === "image") {
    const full = new URL(p.url).pathname.includes("/genai/");
    const path = full ? "" : `/genai/${model}`;
    if (!full && new URL(p.url).hostname !== "ai.api.nvidia.com")
      throw new Error(
        "NVIDIA 图像模型使用独立的 ai.api.nvidia.com 端点。请添加该模型官方文档提供的完整生成 URL，仍只需 URL 和 Key。",
      );
    if (inputs.some((a) => a.mime.startsWith("image/")) && !options.mode)
      throw new Error(
        "此 NVIDIA 图像端点的参考图用法取决于具体模型，请在接口参数中指定其要求的 mode/image，或使用自定义能力定义。",
      );
    const payload = /stable-diffusion/i.test(model)
      ? { text_prompts: [{ text: prompt, weight: 1 }], ...options }
      : { prompt, ...options };
    const j: any = await (await request(path, payload)).json();
    const output = j.artifacts || j.data || j.images;
    if (!output?.length)
      throw new Error("NVIDIA 没有返回图像产出，请核对端点与模型参数。");
    return {
      text: "",
      attachments: await persistOutput(output, "image", model),
    };
  }
  if (capability === "image") {
    const images = inputs.filter((a) => a.mime.startsWith("image/"));
    let j: any;
    if (images.length && vendor === "ark") {
      j = await (
        await request("/images/generations", {
          model,
          prompt,
          image: images.map(
            (a) =>
              `data:${a.mime};base64,${readFileSync(join(filesDir, a.id)).toString("base64")}`,
          ),
          ...options,
        })
      ).json();
    } else if (images.length) {
      const form = new FormData();
      form.set("model", model);
      if (prompt) form.set("prompt", prompt);
      for (const a of images)
        form.append(
          images.length === 1 ? "image" : "image[]",
          new Blob([readFileSync(join(filesDir, a.id))], { type: a.mime }),
          a.name,
        );
      for (const [k, v] of Object.entries(options)) form.set(k, String(v));
      j = await (await request("/images/edits", form)).json();
    } else
      j = await (
        await request("/images/generations", {
          model,
          prompt,
          ...(vendor === "ark" ? {} : { n: 1 }),
          ...options,
        })
      ).json();
    return {
      text:
        j.data
          ?.map((d: any) => d.revised_prompt)
          .filter(Boolean)
          .join("\n\n") || "",
      attachments: await persistOutput(j.data, "image", model),
    };
  }
  if (capability === "speech") {
    const res = await request("/audio/speech", {
      model,
      input: prompt,
      voice: "alloy",
      ...options,
    });
    return {
      text: "",
      attachments: [
        saveFile(
          `${displayName}.mp3`,
          res.headers.get("content-type") || "audio/mpeg",
          await limitedBody(res, 100 * 1024 * 1024),
        ),
      ],
    };
  }
  if (capability === "transcription") {
    const a = inputs.find(
      (a) => a.mime.startsWith("audio/") || a.mime.startsWith("video/"),
    );
    if (!a) throw new Error("请先上传需要转写的音频或视频文件。");
    const form = new FormData();
    form.set("model", model);
    form.set(
      "file",
      new Blob([readFileSync(join(filesDir, a.id))], { type: a.mime }),
      a.name,
    );
    if (prompt) form.set("prompt", prompt);
    for (const [k, v] of Object.entries(options)) form.set(k, String(v));
    const j: any = await (await request("/audio/transcriptions", form)).json();
    return {
      text: managedOutput(p, j.text || JSON.stringify(j)),
      attachments: [],
    };
  }
  if (capability === "embedding") {
    const j = await (
      await request("/embeddings", {
        model,
        input: prompt,
        ...(vendor === "nvidia"
          ? { input_type: "query", truncate: "NONE" }
          : {}),
        ...options,
      })
    ).json();
    return {
      text: "向量已计算，完整结果见文件。",
      attachments: [
        saveFile(
          `${displayName}.json`,
          "application/json",
          Buffer.from(
            JSON.stringify(p.managed ? j.data || j.embedding || j : j, null, 2),
          ),
        ),
      ],
    };
  }
  if (capability === "video") {
    const form = new FormData();
    form.set("model", model);
    if (prompt) form.set("prompt", prompt);
    for (const [k, v] of Object.entries(options)) form.set(k, String(v));
    const image = inputs.find((a) => a.mime.startsWith("image/"));
    if (image)
      form.set(
        "input_reference",
        new Blob([readFileSync(join(filesDir, image.id))], {
          type: image.mime,
        }),
        image.name,
      );
    let j: any = await (await request("/videos", form)).json();
    const id = j.id;
    if (!id) throw new Error("视频接口没有返回任务 ID。");
    const deadline = Date.now() + 20 * 60 * 1000;
    while (!["completed", "succeeded"].includes(j.status)) {
      progress(
        `视频生成中${typeof j.progress === "number" ? ` · ${j.progress}%` : ""} · ${id}`,
      );
      if (["failed", "cancelled"].includes(j.status))
        throw new Error(j.error?.message || `视频任务 ${j.status}`);
      if (Date.now() > deadline)
        throw new Error(`生成超时，远端任务 ID：${id}`);
      await wait(4000, signal);
      j = await (
        await request(`/videos/${encodeURIComponent(id)}`, undefined, "GET")
      ).json();
    }
    const res = await request(
      `/videos/${encodeURIComponent(id)}/content`,
      undefined,
      "GET",
    );
    return {
      text: "",
      attachments: [
        saveFile(
          `${displayName}.mp4`,
          "video/mp4",
          await limitedBody(res, 200 * 1024 * 1024),
        ),
      ],
    };
  }
  throw new Error(
    `未配置「${capability}」能力的执行方式。可在连接高级设置中添加接口定义。`,
  );
}
export async function limitedBody(res: Response, limit: number) {
  if (Number(res.headers.get("content-length") || 0) > limit)
    throw new Error("返回文件超过本机下载大小限制。");
  const reader = res.body!.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("返回文件超过本机下载大小限制。");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  return Buffer.concat(chunks);
}
