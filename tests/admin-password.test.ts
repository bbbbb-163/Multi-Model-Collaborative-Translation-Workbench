import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

process.env.WORKBENCH_DATA = mkdtempSync(join(tmpdir(), "mstar-password-"));
const store = await import("../server/store.ts");
const { createApp } = await import("../server/app.ts");
const { setupCode } = await import("../server/auth.ts");
let server: Server,
  base: string,
  admin: string,
  user: string,
  workspace: string;
let password = "initial-admin-password-123";
const changePath = "/auth/admin/password";
async function request(
  path: string,
  cookie = "",
  method = "GET",
  body?: unknown,
) {
  return fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function sessionCookie(response: Response) {
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function login(value = password) {
  const response = await request("/auth/admin", "", "POST", {
    password: value,
  });
  assert.equal(response.status, 200);
  return sessionCookie(response);
}
function record() {
  return (
    store.db
      .prepare("SELECT value FROM security WHERE id='admin-password'")
      .get() as { value: string }
  ).value;
}
before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const setup = await request("/auth/setup", "", "POST", {
    code: setupCode(),
    password,
  });
  assert.equal(setup.status, 200);
  admin = sessionCookie(setup);
  const workspaceLogin = await request(
    "/auth/admin-workspace",
    admin,
    "POST",
    {},
  );
  assert.equal(workspaceLogin.status, 200);
  workspace = sessionCookie(workspaceLogin);
  const issued = await request("/admin/keys", admin, "POST", {
    label: "Password isolation fixture",
    modelIds: [],
  });
  assert.equal(issued.status, 201);
  const { secret } = await issued.json();
  const userLogin = await request("/auth/login", "", "POST", { key: secret });
  assert.equal(userLogin.status, 200);
  user = sessionCookie(userLogin);
});
after(() => {
  server.closeAllConnections();
  server.close();
  store.db.close();
});

test("changing the administrator password requires a backend administrator session", async () => {
  const previous = record();
  for (const cookie of ["", user, workspace]) {
    const response = await request(changePath, cookie, "POST", {
      currentPassword: password,
      newPassword: "replacement-password-123",
    });
    assert.equal(response.status, 401);
  }
  assert.equal(record(), previous);
});

test("invalid current passwords and new passwords preserve the password and sessions", async () => {
  const previous = record();
  const invalid = [
    {
      currentPassword: "wrong-password",
      newPassword: "replacement-password-123",
    },
    { currentPassword: password, newPassword: "too-short" },
    { currentPassword: password, newPassword: "x".repeat(201) },
    { currentPassword: password, newPassword: password },
    { newPassword: "replacement-password-123" },
    { currentPassword: password, newPassword: 123456789012 },
  ];
  for (const body of invalid) {
    const response = await request(changePath, admin, "POST", body);
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.ok(json.error);
    assert.ok(!json.error.includes(password));
  }
  assert.equal(record(), previous);
  assert.equal((await request("/admin/bootstrap", admin)).status, 200);
  assert.equal((await request("/bootstrap", workspace)).status, 200);
  assert.equal((await request("/bootstrap", user)).status, 200);
});

test("password changes retain the existing cross-site request protection", async () => {
  const previous = record();
  const response = await fetch(base + changePath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: admin,
      Origin: "https://untrusted.example",
    },
    body: JSON.stringify({
      currentPassword: password,
      newPassword: "replacement-password-123",
    }),
  });
  assert.equal(response.status, 403);
  assert.equal(record(), previous);
});

test("a password change is persisted and revokes all administrator sessions while preserving user login", async () => {
  const oldPassword = password;
  const previous = record();
  const otherAdmin = await login();
  const nextPassword = "replacement-admin-password-456";
  const response = await request(changePath, `${admin}; ${user}`, "POST", {
    currentPassword: password,
    newPassword: nextPassword,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get("set-cookie")!, /mstar_admin=;/);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(response.headers.get("set-cookie")!, /SameSite=Strict/i);
  assert.ok(!response.headers.get("set-cookie")!.includes("mstar_session"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const cookie of [admin, otherAdmin]) {
    assert.equal((await request("/admin/bootstrap", cookie)).status, 401);
    assert.equal(
      (await (await request("/auth/status", cookie)).json()).admin,
      false,
    );
  }
  assert.equal((await request("/bootstrap", workspace)).status, 401);
  assert.equal((await request("/bootstrap", user)).status, 200);
  assert.equal(
    (await request("/auth/admin", "", "POST", { password: oldPassword }))
      .status,
    401,
  );
  assert.notEqual(record(), previous);
  const persisted = new DatabaseSync(join(store.dataDir, "workbench.sqlite"), {
    readOnly: true,
  });
  try {
    const { value } = persisted
      .prepare("SELECT value FROM security WHERE id='admin-password'")
      .get() as { value: string };
    const [salt, digest] = value.split(":");
    assert.equal(digest, scryptSync(nextPassword, salt, 64).toString("hex"));
    assert.ok(!value.includes(nextPassword));
  } finally {
    persisted.close();
  }
  password = nextPassword;
  admin = await login();
  assert.equal((await request("/admin/bootstrap", admin)).status, 200);
});

test("an in-flight login with the old password cannot leave a usable session after a change", async () => {
  const nextPassword = "race-safe-admin-password-789";
  const [changed, oldLogin] = await Promise.all([
    request(changePath, admin, "POST", {
      currentPassword: password,
      newPassword: nextPassword,
    }),
    request("/auth/admin", "", "POST", { password }),
  ]);
  assert.equal(changed.status, 200);
  assert.ok([200, 401].includes(oldLogin.status));
  if (oldLogin.ok)
    assert.equal(
      (await request("/admin/bootstrap", sessionCookie(oldLogin))).status,
      401,
    );
  password = nextPassword;
  admin = await login();
});

test("concurrent password changes cannot overwrite the first accepted password", async () => {
  const candidates = [
    "concurrent-password-first",
    "concurrent-password-second",
  ];
  const responses = await Promise.all(
    candidates.map((newPassword) =>
      request(changePath, admin, "POST", {
        currentPassword: password,
        newPassword,
      }),
    ),
  );
  assert.equal(responses.filter((response) => response.ok).length, 1);
  assert.ok(
    responses.every((response) => [200, 401, 409].includes(response.status)),
  );
  const winner = responses.findIndex((response) => response.ok);
  password = candidates[winner];
  assert.equal(
    (
      await request("/auth/admin", "", "POST", {
        password: candidates[1 - winner],
      })
    ).status,
    401,
  );
  admin = await login();
  assert.equal((await request("/bootstrap", user)).status, 200);
});

test("incorrect current passwords are rate limited independently of administrator login", async () => {
  let failures = 0;
  for (let i = 0; i <= 30; i++) {
    const response = await request(changePath, admin, "POST", {
      currentPassword: "incorrect-password",
      newPassword: "unused-new-password-123",
    });
    if (response.status === 429) break;
    assert.equal(response.status, 400);
    failures++;
  }
  // Earlier concurrent requests may already have consumed part of this budget.
  assert.ok(failures > 0 && failures <= 30);
  const blocked = await request(changePath, admin, "POST", {
    currentPassword: password,
    newPassword: "unused-new-password-123",
  });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal((await request("/admin/bootstrap", await login())).status, 200);
});
