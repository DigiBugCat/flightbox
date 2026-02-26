import { serialize } from "@flightbox/core";
import type { Span } from "@flightbox/core";
import { storage } from "./context.js";

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

export function beginEntityTracking(spanId: string): void {
  eventsBySpanId.set(spanId, []);
}

export function finalizeEntityTracking(span: Span): void {
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
  const ctx = storage.getStore();
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
