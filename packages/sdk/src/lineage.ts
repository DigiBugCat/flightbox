// Thin re-export for backward compatibility — actual implementation in causality.ts
export type {
  LineageEvidenceKind,
  LineageSubjectObject,
  LineagePayload,
} from "./causality.js";
export { withLineage, runWithLineage } from "./wrap.js";

// Re-export store functions for internal use
export { lineageStore } from "./wrap.js";

// Legacy exports
import { lineageStore } from "./wrap.js";
import { stampBlastScope as _stampBlastScope } from "./causality.js";
import { getConfig } from "./config.js";

export function beginLineageTracking(spanId: string, actorSystem: string): void {
  lineageStore.beginTracking(spanId, actorSystem);
}

export function finalizeLineageTracking(span: import("@flightbox/core").Span): void {
  lineageStore.finalizeTracking(span);
}

export function stampBlastScope(span: import("@flightbox/core").Span): void {
  _stampBlastScope(span, getConfig().blastScopeId);
}
