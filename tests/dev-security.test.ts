import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { once } from "node:events";

test("development server refuses anonymous reads of data, initialization codes, database and raw imports", async () => {
  mkdirSync("test-results", { recursive: true });
  const dir = mkdtempSync(resolve("test-results/security-vite-"));
  process.env.WORKBENCH_DATA = dir;
  const files = [
    "admin-setup.txt",
    "private.sqlite",
    "private.sqlite-wal",
    "vault.key",
    "private-upload.txt",
  ];
  for (const name of files)
    writeFileSync(resolve(dir, name), "security-fixture-never-serve");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
    logLevel: "silent",
  });
  const app = express();
  app.use(vite.middlewares);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    for (const name of files)
      for (const path of [
        relative(resolve("."), resolve(dir, name)).replace(/\\/g, "/"),
        `@fs/${resolve(dir, name).replace(/\\/g, "/")}`,
      ])
        for (const query of ["", "?raw", "?url"]) {
          const response = await fetch(`${base}/${path}${query}`);
          assert.equal(response.status, 403, `${path}${query}`);
          assert.ok(
            !(await response.text()).includes("security-fixture-never-serve"),
          );
        }
  } finally {
    server.closeAllConnections();
    server.close();
    await vite.close();
  }
});
