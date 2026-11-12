import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// MSTAR_RELEASE_DIR can point to an installation with only production dependencies.
const root = resolve(process.env.MSTAR_RELEASE_DIR || ".");
test(
  "compiled production server: HTTPS cookies, isolation, files and restart persistence",
  { timeout: 45000 },
  async () => {
    await access(join(root, "build/server/index.js"));
    await access(join(root, "dist/index.html"));
    const data = await mkdtemp(join(tmpdir(), "mstar-production-"));
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((done) => socket.close(done));
    const base = `http://127.0.0.1:${port}`;
    let child,
      exited,
      output = "";
    async function stop() {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        delay(5000, undefined, { ref: false }).then(() => {
          throw new Error("Production process did not stop");
        }),
      ]);
    }
    async function start() {
      output = "";
      child = spawn(
        process.execPath,
        ["build/server/index.js", "--production"],
        {
          cwd: root,
          windowsHide: true,
          env: {
            ...process.env,
            NODE_ENV: "production",
            PORT: String(port),
            WORKBENCH_HOST: "127.0.0.1",
            WORKBENCH_ORIGIN: "https://mstar.example",
            WORKBENCH_TRUST_PROXY: "loopback",
            WORKBENCH_DATA: data,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      exited = once(child, "exit");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null)
          throw new Error(`Production startup failed: ${output}`);
        try {
          const res = await fetch(`${base}/api/health`, {
            signal: AbortSignal.timeout(500),
          });
          if (res.ok && (await res.json()).ok) return;
        } catch {}
        await delay(100);
      }
      throw new Error(`Production startup timed out: ${output}`);
    }
    const request = (path, cookie = "", method = "GET", body) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          Host: "mstar.example",
          Origin: "https://mstar.example",
          Cookie: cookie,
          ...(body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
      });
    try {
      await start();
      const page = await request("/admin");
      assert.equal(page.status, 200);
      assert.match(
        page.headers.get("content-security-policy"),
        /script-src 'self'/,
      );
      assert.match(await page.text(), /\/assets\/index-[^" ]+\.js/);
      assert.equal((await request("/api/bootstrap")).status, 401);
      const hostileStatus = await new Promise((done, reject) => {
        const req = httpRequest(
          `${base}/api/health`,
          { headers: { Host: "evil.example" } },
          (res) => {
            res.resume();
            done(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(hostileStatus, 403);
      for (const path of [
        "/.data/vault.key",
        "/runtime/data/vault.key",
        "/.env",
        "/server/store.ts",
      ]) {
        const res = await request(path);
        assert.match(res.headers.get("content-type"), /text\/html/);
        assert.match(await res.text(), /<div id="root">/);
      }
      const code = (
        await readFile(join(data, "admin-setup.txt"), "utf8")
      ).trim();
      const setup = await request("/api/auth/setup", "", "POST", {
        code,
        password: "production-smoke-password",
      });
      assert.equal(setup.status, 200);
      const adminCookie = setup.headers.get("set-cookie");
      assert.match(adminCookie, /HttpOnly/i);
      assert.match(adminCookie, /Secure/i);
      assert.match(adminCookie, /SameSite=Strict/i);
      const admin = adminCookie.split(";")[0];
      const workspace = await request(
        "/api/auth/admin-workspace",
        admin,
        "POST",
        {},
      );
      assert.equal(workspace.status, 200);
      const user = workspace.headers.get("set-cookie").split(";")[0];
      const taskResponse = await request("/api/tasks", user, "POST", {
        title: "Production persistence",
      });
      assert.equal(taskResponse.status, 201);
      const task = await taskResponse.json();
      const form = new FormData();
      form.append(
        "files",
        new Blob(["production-attachment"], { type: "text/plain" }),
        "smoke.txt",
      );
      const upload = await request("/api/files", user, "POST", form);
      assert.equal(upload.status, 201);
      const [file] = await upload.json();
      await stop();
      await start();
      assert.equal(
        (await (await request("/api/auth/status")).json()).needsSetup,
        false,
      );
      const persisted = await request(`/api/tasks/${task.id}`, user);
      assert.equal(persisted.status, 200);
      assert.equal((await persisted.json()).title, "Production persistence");
      assert.equal((await request(file.url)).status, 401);
      assert.equal(
        await (await request(file.url, user)).text(),
        "production-attachment",
      );
      assert.equal((await request("/api/admin/bootstrap", user)).status, 401);
    } finally {
      await stop();
      await rm(data, { recursive: true, force: true });
    }
  },
);
