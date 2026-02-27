import type { Span, SpanContext } from "@flightbox/core";
import { extract, inject } from "./propagation.js";
import { getConfig } from "./config.js";
import { selectTrackedEntityForSpan } from "./entity.js";

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

const lineageBySpanId = new Map<string, SpanLineage>();
const actorBySpanId = new Map<string, string>();
const inboundHopBySpanId = new Map<string, number>();

const DEFAULT_KEY = "_fb";

export function withLineage<T extends Record<string, unknown>>(
  payload: T,
  opts?: { key?: string },
): T {
  if (!isRecord(payload)) {
    throw new Error("withLineage payload must be an object");
  }

  const cfg = getConfig();
  const key = opts?.key ?? cfg.lineage.messageKey ?? DEFAULT_KEY;
  const ctx = extract();
  if (!ctx) return payload;

  if (cfg.lineage.requireBlastScope && !cfg.blastScopeId) {
    return payload;
  }

  const subject = selectTrackedEntityForSpan(ctx.span_id, cfg.entityCatalog.types);
  if (!subject) return payload;

  const lineage: LineagePayload = {
    trace_id: ctx.trace_id,
    span_id: ctx.span_id,
    subject_entity: subject,
    actor_system: actorBySpanId.get(ctx.span_id) ?? "unknown",
    hop: inboundHopBySpanId.get(ctx.span_id) ?? 0,
    max_hops: cfg.lineage.maxHops,
    blast_scope_id: cfg.blastScopeId,
  };

  recordSend(ctx.span_id, lineage);
  return { ...payload, [key]: lineage };
}

export function runWithLineage<T>(
  payload: unknown,
  fn: () => T,
  opts?: { key?: string },
): T {
  const cfg = getConfig();
  const key = opts?.key ?? cfg.lineage.messageKey ?? DEFAULT_KEY;
  const active = extract();
  const hasLineageKey = hasOwnLineageKey(payload, key);
  const lineage = parseLineage(payload, key);

  if (!lineage) {
    if (active && hasLineageKey) {
      recordRecv(active.span_id, {
        trace_id: active.trace_id,
        span_id: active.span_id,
        subject_entity: { type: "UNKNOWN" },
        actor_system: actorBySpanId.get(active.span_id) ?? "unknown",
        hop: 0,
        max_hops: cfg.lineage.maxHops,
        blast_scope_id: cfg.blastScopeId,
      }, "gap");
    }
    return fn();
  }

  if (lineage.hop >= lineage.max_hops) {
    if (active) recordRecv(active.span_id, lineage, "gap");
    return fn();
  }

  if (active) {
    inboundHopBySpanId.set(active.span_id, lineage.hop + 1);
    recordRecv(active.span_id, lineage, "exact");
  }

  const nextContext: SpanContext = {
    trace_id: lineage.trace_id,
    span_id: lineage.span_id,
  };

  return inject(nextContext, fn);
}

export function beginLineageTracking(spanId: string, actorSystem: string): void {
  lineageBySpanId.set(spanId, { lineage_send: [], lineage_recv: [] });
  actorBySpanId.set(spanId, actorSystem);
}

export function finalizeLineageTracking(span: Span): void {
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

export function stampBlastScope(span: Span): void {
  const blastScopeId = getConfig().blastScopeId;
  if (!blastScopeId) return;
  const tags = parseTags(span.tags);
  tags.blast_scope_id = blastScopeId;
  span.tags = JSON.stringify(tags);
}

function recordSend(spanId: string, payload: LineagePayload): void {
  const bucket = lineageBySpanId.get(spanId);
  if (!bucket) return;
  bucket.lineage_send.push({
    ...payload,
    at: Date.now(),
    evidence_kind: "exact",
  });
}

function recordRecv(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
