import type {
  Capability,
  Model,
  Protocol,
  CustomCapability,
} from "../shared/types.ts";
import { inputConstraintsSchema } from "./input-constraints.ts";

export const capabilities: Capability[] = [
  {
    id: "text",
    label: "对话与编码",
    description: "理解上下文、推理、编写代码与调用团队模型",
    input: "any",
  },
  {
    id: "image",
    label: "图像生成",
    description: "生成图片；支持的接口可使用参考图片",
    input: "text",
  },
  {
    id: "video",
    label: "视频生成",
    description: "创建视频并持续查询生成进度",
    input: "text",
  },
  {
    id: "speech",
    label: "语音合成",
    description: "把文本合成为可播放的音频",
    input: "text",
  },
  {
    id: "transcription",
    label: "语音转写",
    description: "将上传的音频转成文字",
    input: "file",
  },
  {
    id: "embedding",
    label: "向量",
    description: "计算文本向量并保存 JSON 结果",
    input: "text",
  },
];
export function inferModel(raw: any, protocol: Protocol): Model {
  const id = String(raw.id || raw.name || "").replace(/^models\//, "");
  const methods: string[] = raw.supportedGenerationMethods || [];
  const declared = raw.capabilities;
  let caps: string[] = [];
  if (Array.isArray(declared))
    caps = declared.filter((v) => typeof v === "string").map(mapCapability);
  else if (declared && typeof declared === "object")
    caps = Object.entries(declared)
      .filter(([, v]) => v === true)
      .map(([k]) => mapCapability(k))
      .filter(Boolean);
  const modalities: string[] =
    raw.architecture?.output_modalities || raw.output_modalities || [];
  caps.push(...modalities.map(mapCapability));
  if (methods.includes("generateContent")) caps.push("text");
  if (methods.some((m) => /predictLongRunning/i.test(m))) caps.push("video");
  if (methods.some((m) => /embedContent/i.test(m))) caps.push("embedding");
  if (methods.includes("predict") && /imagen/i.test(id)) caps.push("image");
  let source: Model["source"] = caps.length ? "metadata" : "inferred";
  if (methods.includes("generateContent") && !modalities.length && !declared) {
    if (/tts|speech/i.test(id)) {
      caps = ["speech"];
      source = "inferred";
    } else if (/image/i.test(id)) {
      caps = ["text", "image"];
      source = "inferred";
    }
  }
  if (!caps.length) {
    if (/embed|bge-|e5-|nomic-embed/i.test(id)) caps = ["embedding"];
    else if (/whisper|transcri|asr/i.test(id)) caps = ["transcription"];
    else if (/tts|speech|kokoro/i.test(id)) caps = ["speech"];
    else if (/sora|veo|video|wan[\d.-]|kling|hunyuanvideo|seedance/i.test(id))
      caps = ["video"];
    else if (
      /dall-e|gpt-image|flux|stable.diffusion|imagen|image-gen|seedream/i.test(
        id,
      )
    )
      caps = ["image"];
    else if (/moderation|rerank|nvclip/i.test(id)) caps = ["custom-required"];
    else caps = ["text"];
  }
  const tools =
    typeof declared?.tools === "boolean"
      ? declared.tools
      : Array.isArray(raw.supported_parameters)
        ? raw.supported_parameters.includes("tools")
        : undefined;
  const explicitInputs = inputConstraintsSchema.safeParse(
    raw.input_constraints || raw.inputConstraints,
  );
  const modalitiesInput =
    raw.architecture?.input_modalities || raw.input_modalities;
  const declaredInputs = Array.isArray(modalitiesInput)
    ? modalitiesInput.filter((m: unknown) =>
        ["text", "image", "audio", "video", "file"].includes(String(m)),
      )
    : [];
  const inputConstraints = explicitInputs.success
    ? explicitInputs.data
    : declaredInputs.length
      ? Object.fromEntries(
          [...new Set(caps)].map((c) => [c, { accepted: declaredInputs }]),
        )
      : undefined;
  return {
    id,
    name: raw.displayName || raw.name?.replace(/^models\//, "") || id,
    capabilities: [...new Set(caps)],
    source,
    contextWindow: raw.context_length || raw.inputTokenLimit,
    description: raw.description,
    tools,
    ...(inputConstraints ? { inputConstraints } : {}),
  };
}
function mapCapability(c: string) {
  return (
    (
      {
        chat: "text",
        completion: "text",
        generateContent: "text",
        image_generation: "image",
        images: "image",
        audio: "speech",
        video_generation: "video",
        embeddings: "embedding",
        tools: "text",
        function_calling: "text",
      } as Record<string, string>
    )[c] || c
  );
}
export function validateCustom(items: CustomCapability[]) {
  for (const c of items) {
    if (
      !/^[a-z][a-z0-9_-]{1,60}$/.test(c.id) ||
      !c.label ||
      !c.path.startsWith("/") ||
      c.path.startsWith("//") ||
      c.path.includes("://")
    )
      throw new Error(
        "自定义能力需要唯一 id、名称及相对接口路径（如 /generate）。",
      );
    if (capabilities.some((b) => b.id === c.id))
      throw new Error("自定义能力 id 不能覆盖内置能力。");
    if (
      c.poll &&
      (!c.poll.path.startsWith("/") ||
        c.poll.path.startsWith("//") ||
        c.poll.path.includes("://"))
    )
      throw new Error("轮询路径必须是相对路径。");
  }
}
