import type { Attachment, CustomCapability, Model } from "../shared/types.ts";
export class CapabilityIntentError extends Error {}

// The allowlist always comes from the resolved model, never from a browser classification.
export function resolveCapability(
  model: Model,
  prompt: string,
  files: Attachment[],
  custom: CustomCapability[] = [],
) {
  const allowed = [...new Set(model.capabilities)];
  if (!allowed.length)
    throw new CapabilityIntentError(
      "此模型暂无可用能力，请联系管理员或更换模型。",
    );
  const text = prompt.trim();
  const instruction = text
    .replace(
      /(?:不要|不需要|不用|无需|别|勿)(?:帮我|给我|你)?(?:生成|制作|创建|合成|画|绘制|朗读|转写|解释)[^，。；;\n]*/g,
      "",
    )
    .replace(
      /\b(?:do not|don't|no need to)\s+(?:generate|create|make|draw|paint|read|transcribe)[^,.;\n]*/gi,
      "",
    );
  if (text && !instruction.replace(/[\s，。；;,!.?？!]/g, ""))
    throw new CapabilityIntentError(
      "请描述本次需要完成的任务，系统不会执行已明确要求取消的生成操作。",
    );
  if (allowed.length === 1) return allowed[0];
  const askingAbout =
    /(?:如何|怎么|怎样|什么是|是什么意思|是否支持|支持.*吗|介绍|解释|教程|教我|区别|how (?:do|to|can)|does .*support|what (?:is|are))/i.test(
      instruction,
    );
  const requests: [string, RegExp][] = [
    [
      "transcription",
      /转写|转录|转成文字|转为文字|音频.*(?:文字|字幕)|语音.*(?:文字|字幕)|提取.*字幕|transcrib|speech.to.text|\basr\b/i,
    ],
    [
      "video",
      /(?:生成|制作|合成|创建|做|变成|转成|转为).{0,30}(?:视频|动画|短片|影片)|(?:让|把).{0,20}(?:图片|这张图|照片|图像).{0,15}(?:动起来|变成动画)|(?:图生|文生)视频|(?:视频|动画).{0,8}(?:生成|制作)|(?:generat|creat|make|render).{0,30}(?:video|animation)|\banimate\b|image.to.video|text.to.video/i,
    ],
    [
      "speech",
      /朗读|读出来|配音|(?:生成|合成|转成|转为).{0,25}(?:语音|音频|声音)|(?:语音|音频).{0,8}合成|text.to.speech|\btts\b|read.{0,25}aloud|(?:generat|creat).{0,20}(?:speech|audio)/i,
    ],
    [
      "image",
      /(?:^|[，。！!；;,\n])(?:请|帮我|给我|替我|再|重新|先|然后|麻烦你|我想|我想要|我需要|需要|想要|能不能|能否|可以)*(?:画|绘制)|(?:生成|制作|创建|设计).{0,30}(?:图片|图像|图标|海报|插画|照片|头像)|(?:图片|图像|插画).{0,8}生成|\b(?:draw|paint|illustrate)\b|(?:generat|creat|make|render).{0,30}(?:image|picture|photo|illustration)/i,
    ],
    [
      "embedding",
      /向量化|(?:计算|生成|提取).{0,20}向量|\bembeddings?\b|\bembed\b/i,
    ],
  ];
  const categories = (id: string) => {
    const c = custom.find((c) => c.id === id);
    return c?.output === "audio"
      ? "speech"
      : c?.output === "image" || c?.output === "video"
        ? c.output
        : id;
  };
  if (!askingAbout) {
    for (const [category, pattern] of requests)
      if (pattern.test(instruction)) {
        const candidates = allowed.filter((id) => categories(id) === category);
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1) {
          const named = candidates.filter((id) => {
            const label = custom.find((c) => c.id === id)?.label;
            return label && text.includes(label);
          });
          if (named.length === 1) return named[0];
        }
      }
    const named = custom.filter(
      (c) =>
        allowed.includes(c.id) && c.label.length >= 2 && text.includes(c.label),
    );
    if (named.length === 1) return named[0].id;
    if (
      files.some((f) => f.mime.startsWith("image/")) &&
      /修改|调整|替换|去掉|去除|移除|抠图|换.*(?:背景|颜色)|把.{0,20}(?:改成|换成)|edit.{0,20}(?:image|photo)/i.test(
        instruction,
      )
    ) {
      const images = allowed.filter((id) => categories(id) === "image");
      if (images.length === 1) return images[0];
    }
  }
  if (
    files.some((f) => /^(audio|video)\//.test(f.mime)) &&
    allowed.includes("transcription") &&
    (!allowed.includes("text") ||
      /(?:说了什么|内容|听写|字幕|转写|转录|transcrib)/i.test(text) ||
      !text)
  )
    return "transcription";
  if (allowed.includes("text")) return "text";
  // Do not silently bill for one arbitrary media type on an ambiguous multi-purpose model.
  throw new CapabilityIntentError(
    "请在任务描述中说明希望生成的内容，例如图片、视频或语音，系统会自动使用模型支持的方式。",
  );
}
