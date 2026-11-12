export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function integer(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} 必须是正整数。`);
  return value;
}
export const limits = {
  storageBytes: integer("WORKBENCH_MAX_STORAGE_MB", 1024) * 1024 * 1024,
  runsPerOwner: integer("WORKBENCH_MAX_RUNS_PER_OWNER", 3),
  totalRuns: integer("WORKBENCH_MAX_TOTAL_RUNS", 24),
  uploadsPerOwner: 1,
  totalUploads: 4,
  streamsPerOwner: 8,
  totalStreams: 128,
  discoveriesPerOwner: 2,
  totalDiscoveries: 12,
};
const resources = new Map<string, Map<string, number>>();
export function acquireResource(
  kind: "upload" | "stream" | "discovery",
  owner: string,
) {
  const counts = resources.get(kind) || new Map<string, number>();
  const perOwner =
    kind === "upload"
      ? limits.uploadsPerOwner
      : kind === "stream"
        ? limits.streamsPerOwner
        : limits.discoveriesPerOwner;
  const total =
    kind === "upload"
      ? limits.totalUploads
      : kind === "stream"
        ? limits.totalStreams
        : limits.totalDiscoveries;
  if (
    (counts.get(owner) || 0) >= perOwner ||
    [...counts.values()].reduce((a, b) => a + b, 0) >= total
  )
    throw new HttpError(
      429,
      "同时进行的请求过多，请关闭多余页面或等待当前操作完成。",
    );
  counts.set(owner, (counts.get(owner) || 0) + 1);
  resources.set(kind, counts);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (counts.get(owner) || 1) - 1;
    if (count) counts.set(owner, count);
    else counts.delete(owner);
  };
}
