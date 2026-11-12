import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as store from "./store.ts";
import type { AccessKey, Identity } from "../shared/types.ts";
import { HttpError } from "./limits.ts";
import { captureAuthenticatedKey } from "./key-management.ts";

const scrypt = promisify(scryptCallback);
let passwordChecks = 0;
async function passwordDigest(password: string, salt: string) {
  if (passwordChecks >= 4)
    throw new HttpError(429, "正在验证的登录请求过多，请稍后重试。");
  passwordChecks++;
  try {
    return (await scrypt(password, salt, 64)) as Buffer;
  } finally {
    passwordChecks--;
  }
}
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const setupPath = join(store.dataDir, "admin-setup.txt");
export function needsSetup() {
  return !store.db
    .prepare("SELECT value FROM security WHERE id='admin-password'")
    .get();
}
export function setupCode() {
  if (!needsSetup()) return undefined;
  if (!existsSync(setupPath))
    writeFileSync(setupPath, randomBytes(24).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
  return readFileSync(setupPath, "utf8").trim();
}
setupCode();
const cookieName = (kind: string) =>
  kind === "admin" ? "mstar_admin" : "mstar_session";
function cookie(req: Request, kind: string) {
  const name = cookieName(kind);
  return req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
type Session = { owner: string; kind: string; expires: number };
function session(req: Request, kind: string): Session | undefined {
  const token = cookie(req, kind);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  const row = store.db
    .prepare(
      "SELECT owner,kind,expires FROM sessions WHERE hash=? AND kind=? AND expires>?",
    )
    .get(hash(token), kind, Date.now()) as Session | undefined;
  if (row?.kind === "user" && !store.keyActive(store.accessKey(row.owner)))
    return;
  return row;
}
export function identity(req: Request): Identity | undefined {
  const user = session(req, "user");
  if (user)
    return {
      id: user.owner,
      label: store.accessKey(user.owner)!.label,
      role: "user",
    };
  // Only an explicitly created workspace session can open the legacy admin workspace.
  // The backend's mstar_admin cookie must never be a fallback for a missing user session.
  if (session(req, "workspace-admin"))
    return { id: store.ADMIN_OWNER, label: "管理员", role: "admin" };
}
export const isAdmin = (req: Request) => !!session(req, "admin");
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdmin(req)) {
    res.status(401).json({ error: "请先登录管理员后台。" });
    return;
  }
  res.locals.adminAuthenticated = true;
  store.withOwner(store.PLATFORM_OWNER, next);
}
export function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = identity(req);
  if (!user) {
    res
      .status(401)
      .json({ error: "登录已失效，请使用有效的 Mstar 密钥重新登录。" });
    return;
  }
  store.withOwner(user.id, next);
}
function secureCookie(req: Request) {
  return req.secure || !!process.env.WORKBENCH_ORIGIN?.startsWith("https://");
}
function destroySession(req: Request, kind: "admin" | "user") {
  const token = cookie(req, kind);
  if (token)
    store.db
      .prepare(
        `DELETE FROM sessions WHERE hash=? AND ${kind === "admin" ? "kind='admin'" : "kind IN ('user','workspace-admin')"}`,
      )
      .run(hash(token));
}
function createSession(
  req: Request,
  res: Response,
  owner: string,
  kind: string,
) {
  destroySession(req, kind === "admin" ? "admin" : "user");
  store.db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
  const token = randomBytes(32).toString("base64url"),
    age = kind === "user" ? 7 * 86400 : 12 * 3600;
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .run(hash(token), owner, kind, Date.now() + age * 1000);
  res.cookie(cookieName(kind), token, {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookie(req),
    path: "/",
    maxAge: age * 1000,
  });
}
// Separate login surfaces; successful logins must not consume the failure budget.
const attempts = new Map<string, { count: number; until: number }>();
export function loginLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  for (const [id, value] of attempts)
    if (value.until <= now) attempts.delete(id);
  const id = `${String(req.route?.path || req.path).toLowerCase()}:${req.ip || req.socket.remoteAddress || "unknown"}`;
  const value = attempts.get(id) || { count: 0, until: now + 15 * 60 * 1000 };
  if (value.count >= 30 || attempts.size >= 10000) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((value.until - now) / 1000))),
    );
    res.status(429).json({ error: "登录尝试过于频繁，请稍后再试。" });
    return;
  }
  attempts.set(id, value);
  res.once("finish", () => {
    if (res.statusCode < 400) attempts.delete(id);
    else if ([400, 401, 403].includes(res.statusCode)) {
      value.count++;
      attempts.set(id, value);
    }
  });
  next();
}
function equal(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
function adminPasswordRecord() {
  return store.db
    .prepare("SELECT value FROM security WHERE id='admin-password'")
    .get() as { value: string } | undefined;
}
export function authRoutes(app: import("express").Express) {
  app.get("/api/auth/status", (req, res) =>
    res.json({
      user: identity(req) || null,
      admin: isAdmin(req),
      needsSetup: needsSetup(),
    }),
  );
  app.post("/api/auth/setup", loginLimit, async (req, res) => {
    const { code, password } = z
      .object({
        code: z.string().min(1).max(200),
        password: z.string().min(12).max(200),
      })
      .parse(req.body);
    const expected = setupCode();
    if (!expected || !equal(code, expected)) {
      res.status(403).json({ error: "初始化码无效，或管理员已经完成初始化。" });
      return;
    }
    const salt = randomBytes(16).toString("hex"),
      digest = (await passwordDigest(password, salt)).toString("hex");
    // INSERT, rather than replace: parallel setup requests cannot overwrite the first password.
    const result = store.db
      .prepare("INSERT OR IGNORE INTO security VALUES('admin-password',?)")
      .run(`${salt}:${digest}`);
    if (!result.changes) {
      res.status(409).json({ error: "管理员已完成初始化，请登录。" });
      return;
    }
    if (existsSync(setupPath)) unlinkSync(setupPath);
    createSession(req, res, store.ADMIN_OWNER, "admin");
    res.json({ ok: true });
  });
  app.post("/api/auth/admin", loginLimit, async (req, res) => {
    const { password } = z
      .object({ password: z.string().max(200) })
      .parse(req.body);
    const record = adminPasswordRecord();
    const [salt, expected] = record?.value.split(":") || [
      "invalid",
      "00".repeat(64),
    ];
    const actual = await passwordDigest(password, salt);
    if (
      !record ||
      !timingSafeEqual(actual, Buffer.from(expected, "hex")) ||
      adminPasswordRecord()?.value !== record.value
    ) {
      res.status(401).json({ error: "管理员密码不正确。" });
      return;
    }
    createSession(req, res, store.ADMIN_OWNER, "admin");
    res.json({ ok: true });
  });
  app.post(
    "/api/auth/admin/password",
    requireAdmin,
    loginLimit,
    async (req, res) => {
      const { currentPassword, newPassword } = z
        .object({
          currentPassword: z.string().min(1).max(200),
          newPassword: z
            .string()
            .min(12, "新密码至少需要 12 位。")
            .max(200, "新密码最多支持 200 位。"),
        })
        .parse(req.body);
      const record = adminPasswordRecord();
      if (!record) throw new HttpError(401, "请先登录管理员后台。");
      const [salt, expected] = record.value.split(":");
      const actual = await passwordDigest(currentPassword, salt);
      if (!timingSafeEqual(actual, Buffer.from(expected, "hex")))
        throw new HttpError(400, "当前密码不正确，请重新输入。");
      if (currentPassword === newPassword)
        throw new HttpError(400, "新密码不能与当前密码相同。");
      const nextSalt = randomBytes(16).toString("hex"),
        nextDigest = (await passwordDigest(newPassword, nextSalt)).toString(
          "hex",
        );
      // Hashing yields to other requests; reject a session revoked in the meantime.
      if (!isAdmin(req))
        throw new HttpError(401, "登录已失效，请重新登录管理员后台。");
      store.db.exec("BEGIN IMMEDIATE");
      try {
        const result = store.db
          .prepare(
            "UPDATE security SET value=? WHERE id='admin-password' AND value=?",
          )
          .run(`${nextSalt}:${nextDigest}`, record.value);
        if (!result.changes)
          throw new HttpError(409, "密码已变更，请使用新密码重新登录。");
        store.db
          .prepare(
            "DELETE FROM sessions WHERE kind IN ('admin','workspace-admin')",
          )
          .run();
        store.db.exec("COMMIT");
      } catch (error) {
        store.db.exec("ROLLBACK");
        throw error;
      }
      res.clearCookie(cookieName("admin"), {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: secureCookie(req),
      });
      res.json({ ok: true });
    },
  );
  app.post("/api/auth/admin-workspace", requireAdmin, (req, res) => {
    if (session(req, "user")) {
      res.status(409).json({
        error:
          "用户工作台已经登录。请先退出该用户，或在独立浏览器配置中打开管理员工作空间。",
      });
      return;
    }
    createSession(req, res, store.ADMIN_OWNER, "workspace-admin");
    res.json({ ok: true });
  });
  app.post("/api/auth/login", loginLimit, (req, res) => {
    const { key } = z
      .object({ key: z.string().min(1).max(200) })
      .parse(req.body);
    const record = store.db
      .prepare("SELECT data FROM access_keys WHERE hash=?")
      .get(hash(key.trim())) as { data: string } | undefined;
    const k = record ? (JSON.parse(record.data) as AccessKey) : undefined;
    if (!store.keyActive(k)) {
      res
        .status(401)
        .json({ error: "密钥无效、已停用或已过期，请联系管理员。" });
      return;
    }
    captureAuthenticatedKey(k.id, key.trim());
    store.db
      .prepare(
        "UPDATE access_keys SET data=json_set(data,'$.lastUsedAt',?) WHERE id=?",
      )
      .run(store.now(), k.id);
    createSession(req, res, k.id, "user");
    res.json({ ok: true });
  });
  app.post("/api/auth/logout", (req, res) => {
    const { admin } = z
      .object({ admin: z.boolean().default(false) })
      .parse(req.body || {});
    const kind = admin ? "admin" : "user";
    destroySession(req, kind);
    res.clearCookie(cookieName(kind), {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookie(req),
    });
    res.json({ ok: true });
  });
}
