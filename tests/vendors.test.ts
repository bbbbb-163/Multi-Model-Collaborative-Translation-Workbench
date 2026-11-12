import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Provider } from "../shared/types.ts";
process.env.WORKBENCH_DATA = mkdtempSync(join(tmpdir(), "workbench-vendors-"));
const store = await import("../server/store.ts");
const test = (name: string, fn: () => void | Promise<void>) =>
  nodeTest(name, () => store.withOwner(store.ADMIN_OWNER, fn));
const { invokeMedia } = await import("../server/media.ts");
const { discover, normalizeUrl, vendorFor } =
  await import("../server/providers.ts");
const { inferModel } = await import("../server/capabilities.ts");
const key = "vendor-fixture-secret";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=";
const json = (v: any, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
function provider(id: string, url: string): Provider {
  return store.putProvider(
    {
      id,
      name: id,
      url,
      protocol: "compatible",
      models: [],
      hasKey: true,
      keyHint: "••••cret",
      createdAt: store.now(),
      customCapabilities: [],
    },
    key,
  );
}
async function intercept<T>(handler: typeof fetch, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
test("Ark host URL defaults to /api/v3 and infers Seedream/Seedance capabilities", () => {
  assert.equal(
    normalizeUrl("https://ark.cn-beijing.volces.com"),
    "https://ark.cn-beijing.volces.com/api/v3",
  );
  assert.equal(vendorFor("https://ark.cn-beijing.volces.com/api/v3"), "ark");
  assert.deepEqual(
    inferModel({ id: "doubao-seedream-fixture" }, "compatible").capabilities,
    ["image"],
  );
  assert.deepEqual(
    inferModel({ id: "doubao-seedance-fixture" }, "compatible").capabilities,
    ["video"],
  );
});
test("Ark Seedream uses JSON reference images and Seedance uses native content tasks", async () => {
  const p = provider("ark-test", "https://ark.cn-beijing.volces.com/api/v3");
  const requests: any[] = [];
  const reference = store.saveFile(
    "reference.png",
    "image/png",
    Buffer.from(png, "base64"),
  );
  await intercept(
    async (input, init) => {
      const url = String(input);
      requests.push({ url, body: init?.body, headers: init?.headers });
      if (url.endsWith("/images/generations"))
        return json({ data: [{ b64_json: png }] });
      if (url.endsWith("/contents/generations/tasks"))
        return json({
          id: "ark-job",
          status: "succeeded",
          content: { video_url: "https://cdn.example/video.mp4" },
        });
      if (url === "https://cdn.example/video.mp4") {
        assert.ok(!(init?.headers as any)?.Authorization);
        return new Response("video", {
          headers: { "Content-Type": "video/mp4" },
        });
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const image = await invokeMedia(
        p,
        "seedream",
        "image",
        "draw",
        [reference],
        { model: "unauthorized-other-model" },
        new AbortController().signal,
        () => {},
      );
      assert.equal(image.attachments[0].mime, "image/png");
      const imageBody = JSON.parse(requests[0].body);
      assert.equal(imageBody.model, "seedream");
      assert.ok(imageBody.image[0].startsWith("data:image/png;base64,"));
      assert.ok(!("n" in imageBody));
      const video = await invokeMedia(
        p,
        "seedance",
        "video",
        "animate",
        image.attachments,
        {},
        new AbortController().signal,
        () => {},
      );
      assert.equal(video.attachments[0].mime, "video/mp4");
      const videoBody = JSON.parse(requests[1].body);
      assert.equal(videoBody.content[1].type, "image_url");
      assert.equal(videoBody.content[1].role, "first_frame");
      assert.ok(
        videoBody.content[1].image_url.url.startsWith("data:image/png;base64,"),
      );
    },
  );
});
test("NVIDIA full image endpoint requires only URL/Key, handles artifact base64 and 202 polling", async () => {
  const url = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev";
  const found = await discover(url, key);
  assert.equal(found.models[0].id, "black-forest-labs/flux.1-dev");
  assert.deepEqual(found.models[0].capabilities, ["image"]);
  const p = provider("nvidia-image", url);
  let poll = false;
  await intercept(
    async (input, init) => {
      if (String(input) === url) {
        const b = JSON.parse(init?.body as string);
        assert.equal(b.prompt, "test image");
        assert.ok(!("n" in b));
        return json({ reqId: "nvcf-job" }, 202, { "NVCF-REQID": "nvcf-job" });
      }
      assert.equal(
        String(input),
        "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/nvcf-job",
      );
      assert.equal((init?.headers as any).Authorization, `Bearer ${key}`);
      poll = true;
      return json({ artifacts: [{ base64: png, finishReason: "SUCCESS" }] });
    },
    async () => {
      const result = await invokeMedia(
        p,
        "black-forest-labs/flux.1-dev",
        "image",
        "test image",
        [],
        {},
        new AbortController().signal,
        () => {},
      );
      assert.equal(result.attachments[0].mime, "image/png");
      assert.ok(poll);
    },
  );
});
test("NVIDIA embedding includes required input_type and allows explicit passage override", async () => {
  const p = provider("nvidia-embed", "https://integrate.api.nvidia.com/v1");
  const bodies: any[] = [];
  await intercept(
    async (input, init) => {
      assert.equal(String(input), `${p.url}/embeddings`);
      bodies.push(JSON.parse(init?.body as string));
      return json({ data: [{ embedding: [1, 2] }] });
    },
    async () => {
      await invokeMedia(
        p,
        "nvidia/embed-qa-4",
        "embedding",
        "test",
        [],
        {},
        new AbortController().signal,
        () => {},
      );
      await invokeMedia(
        p,
        "nvidia/embed-qa-4",
        "embedding",
        "test",
        [],
        { input_type: "passage" },
        new AbortController().signal,
        () => {},
      );
      assert.equal(bodies[0].input_type, "query");
      assert.equal(bodies[1].input_type, "passage");
    },
  );
});
