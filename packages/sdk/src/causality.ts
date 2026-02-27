/**
 * Shared causality primitives — environment-agnostic.
 *
 * Node provides ALS-based ContextProvider, browser provides callStack-based.
 * All entity tracking, lineage propagation, and wrap logic lives here.
 */
import { createSpan, completeSpan, failSpan, serialize } from "@flightbox/core";
import type { Span, SpanContext, SpanMeta } from "@flightbox/core";

// ── Types ────────────────────────────────────────────────────────────

export interface ContextProvider {
  extract(): SpanContext | undefined;
  inject<T>(context: SpanContext, fn: () => T): T;
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

export interface EntityEvent {
  action: EntityAction;
  entity_type: string;
  entity_id?: string;
  snapshot?: string | null;
  changes?: string | null;
  note?: string;
  dimensions?: Record<string, string | number | boolean | null>;
  at: number;
}

export type LineageEvidenceKind = "exact" | "inferred" | "gap";

export interface LineageSubjectEntity {
  type: string;
  id?: string;
}

export interface LineagePayload {
  trace_id: string;
  span_id: string;
  subject_entity: LineageSubjectEntity;
  actor_system: string;
  hop: number;
  max_hops: number;
  blast_scope_id: string | null;
}

interface LineageRecord extends LineagePayload {
  at: number;
  evidence_kind: LineageEvidenceKind;
}

interface SpanLineage {
  lineage_send: LineageRecord[];
  lineage_recv: LineageRecord[];
}

export interface CausalityConfig {
  enabled: boolean;
  blastScopeId: string | null;
  gitSha: string | null;
  entityCatalog: { types: string[] };
  lineage: {
    maxHops: number;
    requireBlastScope: boolean;
    messageKey: string;
  };
}

// ── Entity Store ─────────────────────────────────────────────────────

const MAX_EVENTS_PER_SPAN = 200;

export interface EntityStore {
  beginTracking(spanId: string): void;
  finalizeTracking(span: Span): void;
  selectTrackedEntity(spanId: string, trackedTypes: string[]): LineageSubjectEntity | undefined;
  trackEvent(spanId: string, input: TrackEntityInput): boolean;
  getEvents(spanId: string): EntityEvent[];
}

export function createEntityStore(): EntityStore {
  const eventsBySpanId = new Map<string, EntityEvent[]>();

  return {
    beginTracking(spanId: string): void {
      eventsBySpanId.set(spanId, []);
    },

    finalizeTracking(span: Span): void {
      const events = eventsBySpanId.get(span.span_id);
      eventsBySpanId.delete(span.span_id);
      if (!events || events.length === 0) return;

      const base = parseTags(span.tags);
      const existing = Array.isArray(base.entities) ? (base.entities as unknown[]) : [];
      base.entities = [...existing, ...events];
      span.tags = JSON.stringify(base);
    },

    selectTrackedEntity(spanId: string, trackedTypes: string[]): LineageSubjectEntity | undefined {
      const events = eventsBySpanId.get(spanId);
      if (!events || events.length === 0) return undefined;

      const whitelist = new Set(trackedTypes);
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (whitelist.size > 0 && !whitelist.has(ev.entity_type)) continue;
        return { type: ev.entity_type, id: ev.entity_id };
      }
      return undefined;
    },

    trackEvent(spanId: string, input: TrackEntityInput): boolean {
      const entityType = input.entity_type?.trim();
      if (!entityType) return false;

      let events = eventsBySpanId.get(spanId);
      if (!events) {
        events = [];
        eventsBySpanId.set(spanId, events);
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
    },

    getEvents(spanId: string): EntityEvent[] {
      return [...(eventsBySpanId.get(spanId) ?? [])];
    },
  };
}

// ── Lineage Store ────────────────────────────────────────────────────

export interface LineageStore {
  beginTracking(spanId: string, actorSystem: string): void;
  finalizeTracking(span: Span): void;
  recordSend(spanId: string, payload: LineagePayload): void;
  recordRecv(spanId: string, payload: LineagePayload, kind: LineageEvidenceKind): void;
  getActorSystem(spanId: string): string;
  getInboundHop(spanId: string): number;
  setInboundHop(spanId: string, hop: number): void;
}

export function createLineageStore(): LineageStore {
  const lineageBySpanId = new Map<string, SpanLineage>();
  const actorBySpanId = new Map<string, string>();
  const inboundHopBySpanId = new Map<string, number>();

  return {
    beginTracking(spanId: string, actorSystem: string): void {
      lineageBySpanId.set(spanId, { lineage_send: [], lineage_recv: [] });
      actorBySpanId.set(spanId, actorSystem);
    },

    finalizeTracking(span: Span): void {
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
    },

    recordSend(spanId: string, payload: LineagePayload): void {
      const bucket = lineageBySpanId.get(spanId);
      if (!bucket) return;
      bucket.lineage_send.push({ ...payload, at: Date.now(), evidence_kind: "exact" });
    },

    recordRecv(spanId: string, payload: LineagePayload, evidenceKind: LineageEvidenceKind): void {
      const bucket = lineageBySpanId.get(spanId);
      if (!bucket) return;
      bucket.lineage_recv.push({ ...payload, at: Date.now(), evidence_kind: evidenceKind });
    },

    getActorSystem(spanId: string): string {
      return actorBySpanId.get(spanId) ?? "unknown";
    },

    getInboundHop(spanId: string): number {
      return inboundHopBySpanId.get(spanId) ?? 0;
    },

    setInboundHop(spanId: string, hop: number): void {
      inboundHopBySpanId.set(spanId, hop);
    },
  };
}

// ── Annotation Store ─────────────────────────────────────────────────

export interface AnnotationStore {
  begin(spanId: string): void;
  finalize(span: Span): void;
  set(spanId: string, key: string, value: unknown): boolean;
}

export function createAnnotationStore(): AnnotationStore {
  const annotationsBySpanId = new Map<string, Record<string, unknown>>();

  return {
    begin(spanId: string): void {
      annotationsBySpanId.set(spanId, {});
    },

    finalize(span: Span): void {
      const annotations = annotationsBySpanId.get(span.span_id);
      annotationsBySpanId.delete(span.span_id);
      if (!annotations || Object.keys(annotations).length === 0) return;

      const tags = parseTags(span.tags);
      tags.annotations = { ...(isRecord(tags.annotations) ? tags.annotations : {}), ...annotations };
      span.tags = JSON.stringify(tags);
    },

    set(spanId: string, key: string, value: unknown): boolean {
      const store = annotationsBySpanId.get(spanId);
      if (!store) return false;
      store[key] = value;
      return true;
    },
  };
}

// ── Blast Scope ──────────────────────────────────────────────────────

export function stampBlastScope(span: Span, blastScopeId: string | null): void {
  if (!blastScopeId) return;
  const tags = parseTags(span.tags);
  tags.blast_scope_id = blastScopeId;
  span.tags = JSON.stringify(tags);
}

// ── Lineage Helpers ──────────────────────────────────────────────────

const DEFAULT_KEY = "_fb";

export function createLineageHelpers(
  provider: ContextProvider,
  lineageStore: LineageStore,
  entityStore: EntityStore,
  getConfig: () => CausalityConfig,
) {
  function withLineage<T extends Record<string, unknown>>(
    payload: T,
    opts?: { key?: string },
  ): T {
    if (!isRecord(payload)) {
      throw new Error("withLineage payload must be an object");
    }

    const cfg = getConfig();
    const key = opts?.key ?? cfg.lineage.messageKey ?? DEFAULT_KEY;
    const ctx = provider.extract();
    if (!ctx) return payload;

    if (cfg.lineage.requireBlastScope && !cfg.blastScopeId) {
      return payload;
    }

    const subject = entityStore.selectTrackedEntity(ctx.span_id, cfg.entityCatalog.types);
    if (!subject) return payload;

    const lineage: LineagePayload = {
      trace_id: ctx.trace_id,
      span_id: ctx.span_id,
      subject_entity: subject,
      actor_system: lineageStore.getActorSystem(ctx.span_id),
      hop: lineageStore.getInboundHop(ctx.span_id),
      max_hops: cfg.lineage.maxHops,
      blast_scope_id: cfg.blastScopeId,
    };

    lineageStore.recordSend(ctx.span_id, lineage);
    return { ...payload, [key]: lineage };
  }

  function runWithLineage<T>(
    payload: unknown,
    fn: () => T,
    opts?: { key?: string },
  ): T {
    const cfg = getConfig();
    const key = opts?.key ?? cfg.lineage.messageKey ?? DEFAULT_KEY;
    const active = provider.extract();
    const hasLineageKey = isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, key);
    const lineage = parseLineage(payload, key);

    if (!lineage) {
      if (active && hasLineageKey) {
        lineageStore.recordRecv(active.span_id, {
          trace_id: active.trace_id,
          span_id: active.span_id,
          subject_entity: { type: "UNKNOWN" },
          actor_system: lineageStore.getActorSystem(active.span_id),
          hop: 0,
          max_hops: cfg.lineage.maxHops,
          blast_scope_id: cfg.blastScopeId,
        }, "gap");
      }
      return fn();
    }

    if (lineage.hop >= lineage.max_hops) {
      if (active) lineageStore.recordRecv(active.span_id, lineage, "gap");
      return fn();
    }

    if (active) {
      lineageStore.setInboundHop(active.span_id, lineage.hop + 1);
      lineageStore.recordRecv(active.span_id, lineage, "exact");
    }

    const nextContext: SpanContext = {
      trace_id: lineage.trace_id,
      span_id: lineage.span_id,
    };
    return provider.inject(nextContext, fn);
  }

  return { withLineage, runWithLineage };
}

// ── Wrap Factory ─────────────────────────────────────────────────────

export function createWrap(
  provider: ContextProvider,
  entityStore: EntityStore,
  lineageStore: LineageStore,
  getConfig: () => CausalityConfig,
  bufferSpan: (span: Span) => void,
  annotationStore?: AnnotationStore,
): <T extends (...args: any[]) => any>(fn: T, meta: SpanMeta) => T {
  return function __flightbox_wrap<T extends (...args: any[]) => any>(
    fn: T,
    meta: SpanMeta,
  ): T {
    const isGenerator = fn.constructor?.name === "GeneratorFunction" ||
      fn.constructor?.name === "AsyncGeneratorFunction";

    const wrapped = function (this: unknown, ...args: unknown[]) {
      const cfg = getConfig();
      if (!cfg.enabled) return fn.apply(this, args);

      const parent = provider.extract();
      const span = createSpan(meta, parent, args, this);
      span.git_sha = cfg.gitSha;
      stampBlastScope(span, cfg.blastScopeId);
      entityStore.beginTracking(span.span_id);
      lineageStore.beginTracking(span.span_id, `${span.module}#${span.name}`);
      annotationStore?.begin(span.span_id);

      const ctx: SpanContext = { trace_id: span.trace_id, span_id: span.span_id };

      return provider.inject(ctx, () => {
        try {
          const result = fn.apply(this, args);

          if (isGenerator) {
            completeSpan(span, "[Generator]");
            annotationStore?.finalize(span);
            entityStore.finalizeTracking(span);
            lineageStore.finalizeTracking(span);
            bufferSpan(span);
            return result;
          }

          if (result && typeof result === "object" && typeof (result as any).then === "function") {
            return (result as Promise<unknown>).then(
              (val) => {
                completeSpan(span, val);
                entityStore.finalizeTracking(span);
                lineageStore.finalizeTracking(span);
                bufferSpan(span);
                return val;
              },
              (err) => {
                failSpan(span, err);
                entityStore.finalizeTracking(span);
                lineageStore.finalizeTracking(span);
                bufferSpan(span);
                throw err;
              },
            );
          }

          completeSpan(span, result);
          annotationStore?.finalize(span);
          entityStore.finalizeTracking(span);
          lineageStore.finalizeTracking(span);
          bufferSpan(span);
          return result;
        } catch (err) {
          failSpan(span, err);
          annotationStore?.finalize(span);
          entityStore.finalizeTracking(span);
          lineageStore.finalizeTracking(span);
          bufferSpan(span);
          throw err;
        }
      });
    } as unknown as T;

    Object.defineProperty(wrapped, "name", { value: fn.name });
    Object.defineProperty(wrapped, "length", { value: fn.length });
    return wrapped;
  };
}

// ── Entity Tracking Convenience ──────────────────────────────────────

export function createEntityTrackers(
  provider: ContextProvider,
  entityStore: EntityStore,
) {
  function trackEntity(input: TrackEntityInput): boolean {
    const ctx = provider.extract();
    if (!ctx) return false;
    return entityStore.trackEvent(ctx.span_id, input);
  }

  function trackEntityCreate(
    entityType: string, entityId?: string | number,
    snapshot?: unknown, dimensions?: Record<string, string | number | boolean | null>,
  ): boolean {
    return trackEntity({ action: "create", entity_type: entityType, entity_id: entityId, snapshot, dimensions });
  }

  function trackEntityUpdate(
    entityType: string, entityId?: string | number,
    changes?: unknown, snapshot?: unknown,
    dimensions?: Record<string, string | number | boolean | null>,
  ): boolean {
    return trackEntity({ action: "update", entity_type: entityType, entity_id: entityId, changes, snapshot, dimensions });
  }

  function trackEntityDelete(
    entityType: string, entityId?: string | number,
    snapshot?: unknown, dimensions?: Record<string, string | number | boolean | null>,
  ): boolean {
    return trackEntity({ action: "delete", entity_type: entityType, entity_id: entityId, snapshot, dimensions });
  }

  return { trackEntity, trackEntityCreate, trackEntityUpdate, trackEntityDelete };
}

// ── Annotate Factory ─────────────────────────────────────────────────

export function createAnnotate(
  provider: ContextProvider,
  annotationStore: AnnotationStore,
) {
  /**
   * Add a key/value annotation to the current span's tags.
   * No-op when no active span. Queryable via json_extract_string(tags, '$.annotations.key').
   */
  return function annotate(key: string, value: unknown): boolean {
    const ctx = provider.extract();
    if (!ctx) return false;
    return annotationStore.set(ctx.span_id, key, value);
  };
}

// ── Shared Helpers ───────────────────────────────────────────────────

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
  if (!isRecord(subject) || typeof subject.type !== "string" || subject.type.length === 0) return undefined;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseTags(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeEntityId(entityId: string | number | undefined): string | undefined {
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
