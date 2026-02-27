// Thin re-export for backward compatibility — actual implementation in causality.ts
export type { ObjectAction, TrackObjectInput, ObjectEvent } from "./causality.js";
export {
  trackObject,
  trackObjectCreate,
  trackObjectUpdate,
  trackObjectDelete,
} from "./wrap.js";

// Re-export store functions for internal use by wrap.ts (these were previously module-level)
export { objectStore } from "./wrap.js";

// Legacy exports that existing code may reference
import { objectStore } from "./wrap.js";

export function beginObjectTracking(spanId: string): void {
  objectStore.beginTracking(spanId);
}

export function finalizeObjectTracking(span: import("@flightbox/core").Span): void {
  objectStore.finalizeTracking(span);
}

export function selectTrackedObjectForSpan(
  spanId: string,
  trackedTypes: string[],
): { type: string; id?: string } | undefined {
  return objectStore.selectTrackedObject(spanId, trackedTypes);
}

export function getObjectEventsForSpan(spanId: string): import("./causality.js").ObjectEvent[] {
  return objectStore.getEvents(spanId);
}
