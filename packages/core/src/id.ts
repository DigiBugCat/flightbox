import { nanoid } from "nanoid";

export function spanId(): string {
  return nanoid(16);
}

export function traceId(): string {
  return nanoid(21);
}
