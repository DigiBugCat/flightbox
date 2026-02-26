import type { Span, SpanContext, SpanMeta } from "./types.js";
import { spanId, traceId } from "./id.js";
import { serialize } from "./serializer.js";

export function createSpan(
  meta: SpanMeta,
  parent: SpanContext | undefined,
  args: unknown[],
): Span {
  const sid = spanId();
  const tid = parent?.trace_id ?? traceId();

  return {
    span_id: sid,
    trace_id: tid,
    parent_id: parent?.span_id ?? null,
    kind: meta.kind ?? "function",
    name: meta.name,
    module: meta.module,
    file_line: `${meta.module}:${meta.line}`,
    input: serialize(args),
    output: null,
    error: null,
    started_at: Date.now(),
    ended_at: null,
    duration_ms: null,
    git_sha: null,
    tags: null,
  };
}

export function completeSpan(span: Span, result: unknown): void {
  span.ended_at = Date.now();
  span.duration_ms = span.ended_at - span.started_at;
  span.output = serialize(result);
}

export function failSpan(span: Span, err: unknown): void {
  span.ended_at = Date.now();
  span.duration_ms = span.ended_at - span.started_at;
  span.error = serialize(err);
}
