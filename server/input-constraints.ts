import { z } from "zod";
import type {
  Attachment,
  CustomCapability,
  InputConstraint,
  InputModality,
  Model,
} from "../shared/types.ts";

const modality = z.enum(["text", "image", "audio", "video", "file"]);
export const inputConstraintsSchema = z.record(
  z.string().min(1).max(64),
  z
    .object({
      accepted: z.array(modality).min(1).max(5),
      required: z.array(modality).max(5).optional(),
    })
    .refine(
      (c) => !c.required?.some((m) => !c.accepted.includes(m)),
      "必需输入必须包含在支持的输入中。",
    ),
);
export const inputLabels: Record<InputModality, string> = {
  text: "文字",
  image: "图片",
  audio: "音频",
  video: "视频",
  file: "文件",
};
const fileModality = (a: Attachment): InputModality =>
  a.mime.startsWith("image/")
    ? "image"
    : a.mime.startsWith("audio/")
      ? "audio"
      : a.mime.startsWith("video/")
        ? "video"
        : "file";

export function inputConstraintFor(
  model: Model,
  capability: string,
  custom: CustomCapability[] = [],
): InputConstraint | undefined {
  const declared = model.inputConstraints?.[capability];
  if (declared) return declared;
  if (capability === "speech" || capability === "embedding")
    return { accepted: ["text"], required: ["text"] };
  if (capability === "transcription")
    return { accepted: ["text", "audio", "video"], required: [] };
  const definition = custom.find((c) => c.id === capability);
  // An explicit template that never references the prompt cannot consume user text.
  if (definition?.body) {
    const body = JSON.stringify(definition.body);
    const accepted: InputModality[] = [];
    const required: InputModality[] = [];
    if (/\{\{prompt\}\}/.test(body)) accepted.push("text");
    for (const m of ["image", "audio", "video"] as const)
      if (body.includes(`{{${m}_base64}}`)) {
        accepted.push(m);
        required.push(m);
      }
    if (body.includes("{{files}}")) accepted.push("file");
    if (accepted.length) return { accepted, required };
  }
}

export function assessInputs(
  model: Model,
  capability: string,
  prompt: string,
  files: Attachment[],
  custom: CustomCapability[] = [],
) {
  const constraint = inputConstraintFor(model, capability, custom);
  if (!constraint)
    return {
      prompt,
      files,
      unsupported: [] as InputModality[],
      missing: [] as InputModality[],
      constraint,
    };
  const present = new Set<InputModality>([
    ...(prompt.trim() ? ["text" as const] : []),
    ...files.map(fileModality),
  ]);
  if (files.length) present.add("file");
  const accepts = (m: InputModality) =>
    constraint.accepted.includes(m) ||
    (m !== "text" && constraint.accepted.includes("file"));
  const unsupported = [
    ...new Set([
      ...(prompt.trim() && !accepts("text") ? ["text" as const] : []),
      ...files.filter((f) => !accepts(fileModality(f))).map(fileModality),
    ]),
  ];
  const missing = (constraint.required || []).filter((m) => !present.has(m));
  if (
    capability === "transcription" &&
    !files.some((f) => /^(audio|video)\//.test(f.mime))
  )
    missing.push("audio");
  return {
    prompt: accepts("text") ? prompt : "",
    files: files.filter((f) => accepts(fileModality(f))),
    unsupported,
    missing: [...new Set(missing)],
    constraint,
  };
}

export function inputDescription(items: InputModality[]) {
  return items.map((m) => inputLabels[m]).join("、");
}
