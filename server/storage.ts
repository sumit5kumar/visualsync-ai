// Local disk storage. Media lives under MEDIA_DIR on the server filesystem
// and is served back through /manus-storage/{key} (keeping the URL shape the
// app already expects) and /api/storage/put/{key} for ticket-authorized PUTs.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ENV } from "./_core/env";
import { localBaseUrl } from "./_core/localBaseUrl";

function mediaDir(): string {
  const dir = ENV.mediaDir;
  if (!dir) {
    throw new Error("Storage is not configured: set MEDIA_DIR.");
  }
  return dir;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

export function storageKeyPath(relKey: string): string {
  const key = normalizeKey(relKey);
  const root = path.resolve(mediaDir());
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Invalid storage key.");
  }
  return resolved;
}

export async function ensureStorageDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

const uploadTicket = (key: string): string =>
  crypto.createHmac("sha256", process.env.JWT_SECRET || "local-storage-ticket").update(`storage-put:${key}`).digest("base64url");

export function verifyUploadTicket(key: string, ticket: unknown): boolean {
  if (typeof ticket !== "string") return false;
  const expected = Buffer.from(uploadTicket(key));
  const supplied = Buffer.from(ticket);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export async function storagePresignPut(relKey: string): Promise<{ key: string; uploadUrl: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const uploadUrl = `/api/storage/put/${key}?t=${uploadTicket(key)}`;
  return { key, uploadUrl };
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const filePath = storageKeyPath(key);
  await ensureStorageDir(filePath);
  await fs.writeFile(filePath, data);
  return { key, url: `/manus-storage/${key}` };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/manus-storage/${key}` };
}

export async function storageGetSignedUrl(relKey: string, _signal?: AbortSignal): Promise<string> {
  const key = normalizeKey(relKey).split("/").map(encodeURIComponent).join("/");
  return `${localBaseUrl()}/manus-storage/${key}`;
}
