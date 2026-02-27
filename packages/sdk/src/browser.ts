/// <reference lib="dom" />
/**
 * Browser entry point for Flightbox SDK.
 *
 * Same __flightbox_wrap as the Node SDK but uses:
 * - Plain array as call stack (replaces AsyncLocalStorage — browser is single-threaded)
 * - JSON + WebSocket to Vite dev server (which writes Parquet)
 * - requestIdleCallback batching to avoid blocking frames
 */
import { createSpan, completeSpan, failSpan, serialize } from "@flightbox/core";
import type { Span, SpanMeta, SpanContext } from "@flightbox/core";

// ── Call stack (single-threaded parent tracking) ──────────────────────

const callStack: SpanContext[] = [];

export function extract(): SpanContext | undefined {
  return callStack[callStack.length - 1];
}

export function inject<T>(context: SpanContext, fn: () => T): T {
  callStack.push(context);

  try {
    const result = fn();

    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          popContext(context);
          return value;
        },
        (err) => {
          popContext(context);
          throw err;
        },
      ) as T;
    }

    popContext(context);
    return result;
  } catch (err) {
    popContext(context);
    throw err;
  }
}

export type EntityAction = "create" | "update" | "delete" | "upsert" | "custom";

export interface TrackEntityInput {
  action: EntityAction;
  entity_type: string;
  entity_id?: string | number;
  snapshot?: unknown;
  changes?: unknown;
  note?: string;
  dimensions?: Record<string, string | number | boolean | null>;
}

interface EntityEvent {
  action: EntityAction;
  entity_type: string;
  entity_id?: string;
  snapshot?: string | null;
  changes?: string | null;
  note?: string;
  dimensions?: Record<string, string | number | boolean | null>;
  at: number;
}

const MAX_EVENTS_PER_SPAN = 200;
const eventsBySpanId = new Map<string, EntityEvent[]>();

// ── Config ────────────────────────────────────────────────────────────

interface BrowserConfig {
  enabled: boolean;
  wsUrl: string;
}

const config: BrowserConfig = {
  enabled: true,
  wsUrl: "",
};

export function configure(overrides: Partial<BrowserConfig>): void {
  Object.assign(config, overrides);
  if (overrides.wsUrl) connectWebSocket();
}

// ── WebSocket connection ──────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getDefaultWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/__flightbox`;
}

function connectWebSocket(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  const url = config.wsUrl || getDefaultWsUrl();
  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      drainBuffer();
    };

    ws.onclose = () => {
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 2000);
}

// ── Span buffer + idle flush ──────────────────────────────────────────

const MAX_BATCH_SIZE = 100;

let buffer: Span[] = [];
let idleScheduled = false;

function bufferSpan(span: Span): void {
  buffer.push(span);

  // Force drain if batch is getting large
  if (buffer.length >= MAX_BATCH_SIZE) {
    drainBuffer();
    return;
  }

  if (!idleScheduled) {
    idleScheduled = true;
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(drainBuffer);
    } else {
      setTimeout(drainBuffer, 0);
    }
  }
}

function beginEntityTracking(spanId: string): void {
  eventsBySpanId.set(spanId, []);
}

function finalizeEntityTracking(span: Span): void {
  const events = eventsBySpanId.get(span.span_id);
  eventsBySpanId.delete(span.span_id);
  if (!events || events.length === 0) return;

  let base: Record<string, unknown> = {};
  if (span.tags) {
    try {
      base = JSON.parse(span.tags) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }

  const existing = Array.isArray(base.entities) ? (base.entities as unknown[]) : [];
  base.entities = [...existing, ...events];
  span.tags = JSON.stringify(base);
}

export function trackEntity(input: TrackEntityInput): boolean {
  const ctx = callStack[callStack.length - 1];
  if (!ctx) return false;

  const entityType = input.entity_type?.trim();
  if (!entityType) return false;

  let events = eventsBySpanId.get(ctx.span_id);
  if (!events) {
    events = [];
    eventsBySpanId.set(ctx.span_id, events);
  }

  if (events.length >= MAX_EVENTS_PER_SPAN) return false;

  events.push({
    action: input.action,
    entity_type: entityType,
    entity_id: normalizeEntityId(input.entity_id),
    snapshot: serializeField(input.snapshot),
    changes: serializeField(input.changes),
    note: normalizeNote(input.note),
    dimensions: normalizeDimensions(input.dimensions),
    at: Date.now(),
  });

  return true;
}

export function trackEntityCreate(
  entityType: string,
  entityId?: string | number,
  snapshot?: unknown,
  dimensions?: Record<string, string | number | boolean | null>,
): boolean {
  return trackEntity({
    action: "create",
    entity_type: entityType,
    entity_id: entityId,
    snapshot,
    dimensions,
  });
}

export function trackEntityUpdate(
  entityType: string,
  entityId?: string | number,
  changes?: unknown,
  snapshot?: unknown,
  dimensions?: Record<string, string | number | boolean | null>,
): boolean {
  return trackEntity({
    action: "update",
    entity_type: entityType,
    entity_id: entityId,
    changes,
    snapshot,
    dimensions,
  });
}

export function trackEntityDelete(
  entityType: string,
  entityId?: string | number,
  snapshot?: unknown,
  dimensions?: Record<string, string | number | boolean | null>,
): boolean {
  return trackEntity({
    action: "delete",
    entity_type: entityType,
    entity_id: entityId,
    snapshot,
    dimensions,
  });
}

function drainBuffer(): void {
  idleScheduled = false;
  if (buffer.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const batch = buffer;
  buffer = [];

  try {
    ws.send(JSON.stringify(batch));
  } catch {
    // Drop batch on failure — don't block the app
  }
}

// ── __flightbox_wrap (same signature as Node SDK) ─────────────────────

export function __flightbox_wrap<T extends (...args: any[]) => any>(
  fn: T,
  meta: SpanMeta,
): T {
  // Detect generator functions — they return iterators, not promises
  const isGenerator = fn.constructor?.name === "GeneratorFunction" ||
    fn.constructor?.name === "AsyncGeneratorFunction";

  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (!config.enabled) return fn.apply(this, args);

    const parent = callStack[callStack.length - 1] ?? undefined;
    const span = createSpan(meta, parent, args, this);
    beginEntityTracking(span.span_id);

    const ctx: SpanContext = { trace_id: span.trace_id, span_id: span.span_id };
    callStack.push(ctx);

    try {
      const result = fn.apply(this, args);

      // Generators return iterators — record the span immediately and pass through
      if (isGenerator) {
        callStack.pop();
        completeSpan(span, "[Generator]");
        finalizeEntityTracking(span);
        bufferSpan(span);
        return result;
      }

      if (result && typeof result === "object" && typeof result.then === "function") {
        return (result as Promise<unknown>).then(
          (val) => {
            popContext(ctx);
            completeSpan(span, val);
            finalizeEntityTracking(span);
            bufferSpan(span);
            return val;
          },
          (err) => {
            popContext(ctx);
            failSpan(span, err);
            finalizeEntityTracking(span);
            bufferSpan(span);
            throw err;
          },
        );
      }

      callStack.pop();
      completeSpan(span, result);
      finalizeEntityTracking(span);
      bufferSpan(span);
      return result;
    } catch (err) {
      callStack.pop();
      failSpan(span, err);
      finalizeEntityTracking(span);
      bufferSpan(span);
      throw err;
    }
  } as unknown as T;

  Object.defineProperty(wrapped, "name", { value: fn.name });
  Object.defineProperty(wrapped, "length", { value: fn.length });

  return wrapped;
}

/**
 * Pop a specific context from the call stack.
 * For async functions, the context might not be on top (other sync calls
 * could have pushed/popped in between), so we search from the top.
 */
function popContext(ctx: SpanContext): void {
  for (let i = callStack.length - 1; i >= 0; i--) {
    if (callStack[i] === ctx) {
      callStack.splice(i, 1);
      return;
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normalizeEntityId(
  entityId: string | number | undefined,
): string | undefined {
  if (entityId === undefined || entityId === null) return undefined;
  return String(entityId);
}

function normalizeNote(note: string | undefined): string | undefined {
  if (!note) return undefined;
  return note.length > 300 ? note.slice(0, 300) + "..." : note;
}

function normalizeDimensions(
  dimensions: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!dimensions) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(dimensions)) {
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return serialize(value, {
    maxDepth: 3,
    maxBreadth: 20,
    maxStringLength: 256,
    maxReprLength: 150,
  });
}

// ── Auto-connect on import ────────────────────────────────────────────

connectWebSocket();
