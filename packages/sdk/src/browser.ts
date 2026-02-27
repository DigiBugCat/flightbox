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

// Injected by @flightbox/unplugin/vite define config.
declare const __FLIGHTBOX_BLAST_SCOPE_ID__: string | undefined;
declare const __FLIGHTBOX_ENTITY_TYPES__: string[] | undefined;

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

interface LineageSubjectEntity {
  type: string;
  id?: string;
}

interface LineagePayload {
  trace_id: string;
  span_id: string;
  subject_entity: LineageSubjectEntity;
  actor_system: string;
  hop: number;
  max_hops: number;
  blast_scope_id: string | null;
}

type LineageEvidenceKind = "exact" | "inferred" | "gap";

interface LineageRecord extends LineagePayload {
  at: number;
  evidence_kind: LineageEvidenceKind;
}

interface SpanLineage {
  lineage_send: LineageRecord[];
  lineage_recv: LineageRecord[];
}

const MAX_EVENTS_PER_SPAN = 200;
const eventsBySpanId = new Map<string, EntityEvent[]>();
const lineageBySpanId = new Map<string, SpanLineage>();
const actorBySpanId = new Map<string, string>();
const inboundHopBySpanId = new Map<string, number>();

// ── Config ────────────────────────────────────────────────────────────

interface BrowserConfig {
  enabled: boolean;
  wsUrl: string;
  blastScopeId: string | null;
  entityCatalog: {
    types: string[];
  };
  lineage: {
    maxHops: number;
    requireBlastScope: boolean;
    messageKey: string;
  };
}

const config: BrowserConfig = {
  enabled: true,
  wsUrl: "",
  blastScopeId: readDefinedString("__FLIGHTBOX_BLAST_SCOPE_ID__"),
  entityCatalog: {
    types: readDefinedStringArray("__FLIGHTBOX_ENTITY_TYPES__"),
  },
  lineage: {
    maxHops: 2,
    requireBlastScope: true,
    messageKey: "_fb",
  },
};

export function configure(overrides: Partial<BrowserConfig>): void {
  const { entityCatalog, lineage, ...rest } = overrides;
  Object.assign(config, rest);

  if (entityCatalog) {
    config.entityCatalog = {
      ...config.entityCatalog,
      ...entityCatalog,
      types: normalizeEntityTypes(entityCatalog.types ?? config.entityCatalog.types),
    };
  }

  if (lineage) {
    config.lineage = {
      ...config.lineage,
      ...lineage,
    };
  }

  if (overrides.wsUrl) connectWebSocket();
}

// ── Lineage helpers ───────────────────────────────────────────────────

export function withLineage<T extends Record<string, unknown>>(
  payload: T,
  opts?: { key?: string },
): T {
  if (!isRecord(payload)) {
    throw new Error("withLineage payload must be an object");
  }

  const key = opts?.key ?? config.lineage.messageKey;
  const ctx = extract();
  if (!ctx) return payload;

  if (config.lineage.requireBlastScope && !config.blastScopeId) {
    return payload;
  }

  const subject = selectTrackedEntityForSpan(ctx.span_id, config.entityCatalog.types);
  if (!subject) return payload;

  const lineage: LineagePayload = {
    trace_id: ctx.trace_id,
    span_id: ctx.span_id,
    subject_entity: subject,
    actor_system: actorBySpanId.get(ctx.span_id) ?? "unknown",
    hop: inboundHopBySpanId.get(ctx.span_id) ?? 0,
    max_hops: config.lineage.maxHops,
    blast_scope_id: config.blastScopeId,
  };

  recordLineageSend(ctx.span_id, lineage);
  return { ...payload, [key]: lineage };
}

export function runWithLineage<T>(
  payload: unknown,
  fn: () => T,
  opts?: { key?: string },
): T {
  const key = opts?.key ?? config.lineage.messageKey;
  const active = extract();
  const hasLineageKey = hasOwnLineageKey(payload, key);
  const lineage = parseLineage(payload, key);

  if (!lineage) {
    if (active && hasLineageKey) {
      recordLineageRecv(active.span_id, {
        trace_id: active.trace_id,
        span_id: active.span_id,
        subject_entity: { type: "UNKNOWN" },
        actor_system: actorBySpanId.get(active.span_id) ?? "unknown",
        hop: 0,
        max_hops: config.lineage.maxHops,
        blast_scope_id: config.blastScopeId,
      }, "gap");
    }
    return fn();
  }

  if (lineage.hop >= lineage.max_hops) {
    if (active) recordLineageRecv(active.span_id, lineage, "gap");
    return fn();
  }

  if (active) {
    inboundHopBySpanId.set(active.span_id, lineage.hop + 1);
    recordLineageRecv(active.span_id, lineage, "exact");
  }

  const nextContext: SpanContext = {
    trace_id: lineage.trace_id,
    span_id: lineage.span_id,
  };
  return inject(nextContext, fn);
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

  const base = parseTags(span.tags);
  const existing = Array.isArray(base.entities) ? (base.entities as unknown[]) : [];
  base.entities = [...existing, ...events];
  span.tags = JSON.stringify(base);
}

function beginLineageTracking(spanId: string, actorSystem: string): void {
  lineageBySpanId.set(spanId, { lineage_send: [], lineage_recv: [] });
  actorBySpanId.set(spanId, actorSystem);
}

function finalizeLineageTracking(span: Span): void {
  const bucket = lineageBySpanId.get(span.span_id);
  lineageBySpanId.delete(span.span_id);
  actorBySpanId.delete(span.span_id);
  inboundHopBySpanId.delete(span.span_id);
  if (!bucket) return;
  if (bucket.lineage_send.length === 0 && bucket.lineage_recv.length === 0) return;

  const tags = parseTags(span.tags);
  tags.lineage_send = [
    ...(Array.isArray(tags.lineage_send) ? tags.lineage_send : []),
    ...bucket.lineage_send,
  ];
  tags.lineage_recv = [
    ...(Array.isArray(tags.lineage_recv) ? tags.lineage_recv : []),
    ...bucket.lineage_recv,
  ];
  span.tags = JSON.stringify(tags);
}

function stampBlastScope(span: Span): void {
  if (!config.blastScopeId) return;
  const tags = parseTags(span.tags);
  tags.blast_scope_id = config.blastScopeId;
  span.tags = JSON.stringify(tags);
}

function recordLineageSend(spanId: string, payload: LineagePayload): void {
  const bucket = lineageBySpanId.get(spanId);
  if (!bucket) return;
  bucket.lineage_send.push({
    ...payload,
    at: Date.now(),
    evidence_kind: "exact",
  });
}

function recordLineageRecv(
  spanId: string,
  payload: LineagePayload,
  evidenceKind: LineageEvidenceKind,
): void {
  const bucket = lineageBySpanId.get(spanId);
  if (!bucket) return;
  bucket.lineage_recv.push({
    ...payload,
    at: Date.now(),
    evidence_kind: evidenceKind,
  });
}

function selectTrackedEntityForSpan(
  spanId: string,
  trackedTypes: string[],
): LineageSubjectEntity | undefined {
  const events = eventsBySpanId.get(spanId);
  if (!events || events.length === 0) return undefined;

  const whitelist = new Set(trackedTypes);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (whitelist.size > 0 && !whitelist.has(ev.entity_type)) continue;
    return {
      type: ev.entity_type,
      id: ev.entity_id,
    };
  }

  return undefined;
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
    stampBlastScope(span);
    beginEntityTracking(span.span_id);
    beginLineageTracking(span.span_id, `${span.module}#${span.name}`);

    const ctx: SpanContext = { trace_id: span.trace_id, span_id: span.span_id };
    callStack.push(ctx);

    try {
      const result = fn.apply(this, args);

      // Generators return iterators — record the span immediately and pass through
      if (isGenerator) {
        callStack.pop();
        completeSpan(span, "[Generator]");
        finalizeEntityTracking(span);
        finalizeLineageTracking(span);
        bufferSpan(span);
        return result;
      }

      if (result && typeof result === "object" && typeof result.then === "function") {
        return (result as Promise<unknown>).then(
          (val) => {
            popContext(ctx);
            completeSpan(span, val);
            finalizeEntityTracking(span);
            finalizeLineageTracking(span);
            bufferSpan(span);
            return val;
          },
          (err) => {
            popContext(ctx);
            failSpan(span, err);
            finalizeEntityTracking(span);
            finalizeLineageTracking(span);
            bufferSpan(span);
            throw err;
          },
        );
      }

      callStack.pop();
      completeSpan(span, result);
      finalizeEntityTracking(span);
      finalizeLineageTracking(span);
      bufferSpan(span);
      return result;
    } catch (err) {
      callStack.pop();
      failSpan(span, err);
      finalizeEntityTracking(span);
      finalizeLineageTracking(span);
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

function parseLineage(payload: unknown, key: string): LineagePayload | undefined {
  if (!isRecord(payload)) return undefined;
  const raw = payload[key];
  if (!isRecord(raw)) return undefined;

  const traceId = raw.trace_id;
  const spanId = raw.span_id;
  const actorSystem = raw.actor_system;
  const hop = raw.hop;
  const maxHops = raw.max_hops;
  const blastScopeId = raw.blast_scope_id;
  const subject = raw.subject_entity;

  if (typeof traceId !== "string" || traceId.length === 0) return undefined;
  if (typeof spanId !== "string" || spanId.length === 0) return undefined;
  if (typeof actorSystem !== "string" || actorSystem.length === 0) return undefined;
  if (typeof hop !== "number" || !Number.isFinite(hop) || hop < 0) return undefined;
  if (typeof maxHops !== "number" || !Number.isFinite(maxHops) || maxHops < 1) return undefined;
  if (blastScopeId != null && typeof blastScopeId !== "string") return undefined;
  if (!isRecord(subject) || typeof subject.type !== "string" || subject.type.length === 0) {
    return undefined;
  }
  if (subject.id != null && typeof subject.id !== "string") return undefined;

  return {
    trace_id: traceId,
    span_id: spanId,
    subject_entity: {
      type: subject.type,
      id: typeof subject.id === "string" ? subject.id : undefined,
    },
    actor_system: actorSystem,
    hop,
    max_hops: maxHops,
    blast_scope_id: typeof blastScopeId === "string" ? blastScopeId : null,
  };
}

function hasOwnLineageKey(payload: unknown, key: string): boolean {
  return isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, key);
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

function parseTags(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeEntityTypes(input: unknown[]): string[] {
  return [...new Set(
    input
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  )];
}

function readDefinedString(symbolName: string): string | null {
  if (symbolName === "__FLIGHTBOX_BLAST_SCOPE_ID__") {
    return typeof __FLIGHTBOX_BLAST_SCOPE_ID__ === "string"
      ? __FLIGHTBOX_BLAST_SCOPE_ID__
      : null;
  }
  return null;
}

function readDefinedStringArray(symbolName: string): string[] {
  if (symbolName === "__FLIGHTBOX_ENTITY_TYPES__") {
    if (typeof __FLIGHTBOX_ENTITY_TYPES__ === "undefined") return [];
    if (!Array.isArray(__FLIGHTBOX_ENTITY_TYPES__)) return [];
    return normalizeEntityTypes(__FLIGHTBOX_ENTITY_TYPES__);
  }
  return [];
}

// ── Auto-connect on import ────────────────────────────────────────────

connectWebSocket();
