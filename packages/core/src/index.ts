export type {
  Span,
  SpanMeta,
  SpanContext,
  SerializerOptions,
} from "./types.js";
export { serialize } from "./serializer.js";
export { spanId, traceId } from "./id.js";
export { createSpan, completeSpan, failSpan } from "./span.js";
