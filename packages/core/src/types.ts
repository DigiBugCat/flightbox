export interface Span {
  span_id: string;
  trace_id: string;
  parent_id: string | null;

  kind: "function" | "db" | "http" | "stream";
  name: string;
  module: string;
  file_line: string;

  input: string | null;
  output: string | null;
  error: string | null;

  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;

  git_sha: string | null;
  tags: string | null;
}

export interface SpanMeta {
  name: string;
  module: string;
  line: number;
  kind?: Span["kind"];
}

export interface SpanContext {
  trace_id: string;
  span_id: string;
}

export interface SerializerOptions {
  maxDepth?: number;
  maxBreadth?: number;
  maxStringLength?: number;
  maxReprLength?: number;
}
