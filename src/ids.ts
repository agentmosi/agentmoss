import { createHash, randomUUID } from "node:crypto";

export function createEventId(prefix = "evt"): string {
  return `${prefix}_${randomUUID()}`;
}

export function digestPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

export function now(): number {
  return Date.now();
}
