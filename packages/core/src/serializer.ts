import type { SerializerOptions } from "./types.js";

const DEFAULT_OPTIONS: Required<SerializerOptions> = {
  maxDepth: 5,
  maxBreadth: 10,
  maxStringLength: 512,
  maxReprLength: 200,
};

export function serialize(
  value: unknown,
  options: SerializerOptions = {},
): string | null {
  if (value === undefined) return null;
  const opts = { ...DEFAULT_OPTIONS, ...options };
  try {
    const result = serializeValue(value, opts.maxDepth, opts, new WeakSet());
    return JSON.stringify(result);
  } catch {
    return null;
  }
}

function serializeValue(
  value: unknown,
  depth: number,
  opts: Required<SerializerOptions>,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  const type = typeof value;

  if (type === "boolean" || type === "number") return value;

  if (type === "bigint") return value.toString() + "n";

  if (type === "string") {
    return (value as string).length > opts.maxStringLength
      ? (value as string).slice(0, opts.maxStringLength) + "..."
      : value;
  }

  if (type === "symbol") return value.toString();

  if (type === "function") {
    return `<function: ${(value as Function).name || "anonymous"}>`;
  }

  if (type !== "object") {
    return truncate(String(value), opts.maxReprLength);
  }

  const obj = value as object;

  // Circular reference detection
  if (seen.has(obj)) return "<circular>";
  seen.add(obj);

  // Special object types
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof RegExp) return obj.toString();
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: truncate(obj.message, opts.maxStringLength),
      stack: obj.stack
        ? truncate(obj.stack, opts.maxStringLength)
        : undefined,
    };
  }

  if (depth <= 0) {
    return truncate(safeRepr(obj), opts.maxReprLength);
  }

  // Arrays
  if (Array.isArray(obj)) {
    const items = obj.slice(0, opts.maxBreadth).map((item) =>
      serializeValue(item, depth - 1, opts, seen),
    );
    if (obj.length > opts.maxBreadth) {
      items.push(`... ${obj.length - opts.maxBreadth} more`);
    }
    seen.delete(obj);
    return items;
  }

  // Map
  if (obj instanceof Map) {
    const result: Record<string, unknown> = { __type: "Map" };
    let count = 0;
    for (const [k, v] of obj) {
      if (count >= opts.maxBreadth) {
        result[`... ${obj.size - count} more`] = "...";
        break;
      }
      result[String(k)] = serializeValue(v, depth - 1, opts, seen);
      count++;
    }
    seen.delete(obj);
    return result;
  }

  // Set
  if (obj instanceof Set) {
    const items: unknown[] = [];
    let count = 0;
    for (const v of obj) {
      if (count >= opts.maxBreadth) {
        items.push(`... ${obj.size - count} more`);
        break;
      }
      items.push(serializeValue(v, depth - 1, opts, seen));
      count++;
    }
    seen.delete(obj);
    return { __type: "Set", values: items };
  }

  // Plain objects
  const result: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  const limit = Math.min(keys.length, opts.maxBreadth);

  for (let i = 0; i < limit; i++) {
    result[keys[i]] = serializeValue(
      (obj as Record<string, unknown>)[keys[i]],
      depth - 1,
      opts,
      seen,
    );
  }

  if (keys.length > opts.maxBreadth) {
    result[`... ${keys.length - opts.maxBreadth} more`] = "...";
  }

  seen.delete(obj);
  return result;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + "..." : str;
}

function safeRepr(obj: object): string {
  try {
    const s = JSON.stringify(obj);
    if (s !== undefined) return s;
  } catch {
    // fall through
  }
  try {
    return String(obj);
  } catch {
    return "[unserializable]";
  }
}
