// Thin re-export for backward compatibility — actual implementation in causality.ts
export type { EntityAction, TrackEntityInput, EntityEvent } from "./causality.js";
export {
  trackEntity,
  trackEntityCreate,
  trackEntityUpdate,
  trackEntityDelete,
} from "./wrap.js";

// Re-export store functions for internal use by wrap.ts (these were previously module-level)
export { entityStore } from "./wrap.js";

// Legacy exports that existing code may reference
import { entityStore } from "./wrap.js";

export function beginEntityTracking(spanId: string): void {
  entityStore.beginTracking(spanId);
}

export function finalizeEntityTracking(span: import("@flightbox/core").Span): void {
  entityStore.finalizeTracking(span);
}

export function selectTrackedEntityForSpan(
  spanId: string,
  trackedTypes: string[],
): { type: string; id?: string } | undefined {
  return entityStore.selectTrackedEntity(spanId, trackedTypes);
}

export function getEntityEventsForSpan(spanId: string): import("./causality.js").EntityEvent[] {
  return entityStore.getEvents(spanId);
}
