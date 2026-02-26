/// <reference lib="dom" />
/**
 * Browser entry point for Flightbox SDK.
 *
 * Same __flightbox_wrap as the Node SDK but uses:
 * - Plain array as call stack (replaces AsyncLocalStorage — browser is single-threaded)
 * - JSON + WebSocket to Vite dev server (which writes Parquet)
 * - requestIdleCallback batching to avoid blocking frames
 */
import { createSpan, completeSpan, failSpan } from "@flightbox/core";
import type { Span, SpanMeta, SpanContext } from "@flightbox/core";

// ── Call stack (single-threaded parent tracking) ──────────────────────

const callStack: SpanContext[] = [];

// ── Config ────────────────────────────────────────────────────────────

interface BrowserConfig {
  enabled: boolean;
  wsUrl: string;
}

const config: BrowserConfig = {
  enabled: true,
  wsUrl: "",
};

export function configure(overrides: Partial<BrowserConfig>): void {
  Object.assign(config, overrides);
  if (overrides.wsUrl) connectWebSocket();
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

let buffer: Span[] = [];
let idleScheduled = false;

function bufferSpan(span: Span): void {
  buffer.push(span);

  if (!idleScheduled) {
    idleScheduled = true;
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(drainBuffer);
    } else {
      setTimeout(drainBuffer, 0);
    }
  }
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
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (!config.enabled) return fn.apply(this, args);

    const parent = callStack[callStack.length - 1] ?? undefined;
    const span = createSpan(meta, parent, args, this);

    const ctx: SpanContext = { trace_id: span.trace_id, span_id: span.span_id };
    callStack.push(ctx);

    try {
      const result = fn.apply(this, args);

      if (result && typeof result === "object" && typeof result.then === "function") {
        return (result as Promise<unknown>).then(
          (val) => {
            popContext(ctx);
            completeSpan(span, val);
            bufferSpan(span);
            return val;
          },
          (err) => {
            popContext(ctx);
            failSpan(span, err);
            bufferSpan(span);
            throw err;
          },
        );
      }

      callStack.pop();
      completeSpan(span, result);
      bufferSpan(span);
      return result;
    } catch (err) {
      callStack.pop();
      failSpan(span, err);
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

// ── Auto-connect on import ────────────────────────────────────────────

connectWebSocket();
