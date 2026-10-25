import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function setSessionCookie(req: Request, res: Response, openId: string, name: string) {
  const sessionToken = await sdk.createSessionToken(openId, { name, expiresInMs: ONE_YEAR_MS });
  res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
}

export function registerLocalAuthRoutes(app: Express) {
  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = normalizeEmail(body.email);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!name) return res.status(400).json({ error: "Enter a display name." });
      if (!EMAIL_PATTERN.test(email) || email.length > 320) return res.status(400).json({ error: "Enter a valid email address." });
      if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return res.status(400).json({ error: `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.` });
      const existing = await db.getUserByOpenId(email);
      if (existing) return res.status(409).json({ error: "An account with this email already exists. Sign in instead." });
      const passwordHash = await hashPassword(password);
      await db.upsertUser({ openId: email, name, email, loginMethod: "email", passwordHash });
      await setSessionCookie(req, res, email, name);
      return res.status(201).json({ success: true });
    } catch (error) {
      console.error("[Auth] Register failed", error);
      return res.status(500).json({ error: "Account could not be created. Try again." });
    }
  });

  app.post("/api/auth/login", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = normalizeEmail(body.email);
      const password = typeof body.password === "string" ? body.password : "";
      const user = await db.getUserByOpenId(email);
      const passwordValid = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
      if (!user || !passwordValid) return res.status(401).json({ error: "Invalid email or password." });
      await db.upsertUser({ openId: user.openId, lastSignedIn: new Date() });
      await setSessionCookie(req, res, user.openId, user.name ?? "");
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("[Auth] Login failed", error);
      return res.status(500).json({ error: "Sign in failed. Try again." });
    }
  });
}
