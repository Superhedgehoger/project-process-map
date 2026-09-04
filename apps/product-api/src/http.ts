import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApplicationError } from "../../../packages/application/src/errors.ts";

export type JsonBody = Record<string, unknown>;

export async function readJson(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 3 * 1024 * 1024) throw new ApplicationError("REQUEST_TOO_LARGE", "Request body exceeds 3 MiB");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as JsonBody;
  } catch {
    throw new ApplicationError("INVALID_JSON", "Request body must be a JSON object");
  }
}

export function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name]?.toString().trim();
  if (value === undefined || value.length === 0) throw new ApplicationError("IDEMPOTENCY_KEY_REQUIRED", `${name} header is required`);
  return value;
}

export function requiredString(body: JsonBody, name: string): string {
  const value = optionalString(body[name]);
  if (value === undefined) throw new ApplicationError("VALIDATION_FAILED", `${name} is required`);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function optionalBodyString(body: JsonBody, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApplicationError("VALIDATION_FAILED", `${name} must be a string`);
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

export function optionalBodyBoolean(body: JsonBody, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ApplicationError("VALIDATION_FAILED", `${name} must be boolean`);
  return value;
}

export function requiredPositiveInteger(body: JsonBody, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApplicationError("VALIDATION_FAILED", `${name} must be a positive integer`);
  }
  return value;
}

export function deterministicPublicId(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function setCors(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization,content-type,idempotency-key,x-correlation-id");
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}
