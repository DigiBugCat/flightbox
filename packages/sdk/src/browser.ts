/// <reference lib="dom" />
/**
 * Browser entry point for Flightbox SDK.
 *
 * Uses shared causality primitives from causality.ts with a browser-specific
 * ContextProvider (plain array call stack instead of AsyncLocalStorage).
 */
import type { Span, SpanContext } from "@flightbox/core";
import {
  createWrap,
  createObjectStore,
  createLineageStore,
  createAnnotationStore,
  createObjectTrackers,
  createLineageHelpers,
  createAnnotate,
  type ContextProvider,
  type CausalityConfig,
} from "./causality.js";

// Injected by @flightbox/unplugin/vite define config.
declare const __FLIGHTBOX_BLAST_SCOPE_ID__: string | undefined;
declare const __FLIGHTBOX_OBJECT_TYPES__: string[] | undefined;

// ── Browser Context Provider (single-threaded call stack) ────────────

const callStack: SpanContext[] = [];

export function extract(): SpanContext | undefined {
  return callStack[callStack.length - 1];
}

export function inject<T>(context: SpanContext, fn: () => T): T {
  callStack.push(context);
  try {
    const result = fn();
    if (isPromiseLike(result)) {
      return result.then(
        (value) => { popContext(context); return value; },
        (err) => { popContext(context); throw err; },
      ) as T;
    }
    popContext(context);
    return result;
  } catch (err) {
    popContext(context);
    throw err;
  }
}

function popContext(ctx: SpanContext): void {
  for (let i = callStack.length - 1; i >= 0; i--) {
    if (callStack[i] === ctx) {
      callStack.splice(i, 1);
      return;
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

const browserProvider: ContextProvider = { extract, inject };

// ── Config ───────────────────────────────────────────────────────────

interface BrowserConfig {
  enabled: boolean;
  wsUrl: string;
  blastScopeId: string | null;
  gitSha: string | null;
  objectCatalog: { types: string[] };
  lineage: {
    maxHops: number;
    requireBlastScope: boolean;
    messageKey: string;
  };
}

const config: BrowserConfig = {
  enabled: true,
  wsUrl: "",
  blastScopeId: readDefinedString("__FLIGHTBOX_BLAST_SCOPE_ID__"),
  gitSha: null,
  objectCatalog: {
    types: readDefinedStringArray("__FLIGHTBOX_OBJECT_TYPES__"),
  },
  lineage: {
    maxHops: 2,
    requireBlastScope: true,
    messageKey: "_fb",
  },
};

export function configure(overrides: Partial<BrowserConfig>): void {
  const { objectCatalog, lineage, ...rest } = overrides;
  Object.assign(config, rest);
  if (objectCatalog) {
    config.objectCatalog = {
      ...config.objectCatalog,
      ...objectCatalog,
      types: normalizeObjectTypes(objectCatalog.types ?? config.objectCatalog.types),
    };
  }
  if (lineage) {
    config.lineage = { ...config.lineage, ...lineage };
  }
  if (overrides.wsUrl) connectWebSocket();
}

function getCausalityConfig(): CausalityConfig {
  return {
    enabled: config.enabled,
    blastScopeId: config.blastScopeId,
    gitSha: config.gitSha,
    objectCatalog: config.objectCatalog,
    lineage: config.lineage,
  };
}

// ── Shared stores + factories ────────────────────────────────────────

const objectStore = createObjectStore();
const lineageStore = createLineageStore();
const annotationStore = createAnnotationStore();

export const __flightbox_wrap = createWrap(
  browserProvider,
  objectStore,
  lineageStore,
  getCausalityConfig,
  bufferSpan,
  annotationStore,
);

export const annotate = createAnnotate(browserProvider, annotationStore);

const trackers = createObjectTrackers(browserProvider, objectStore);
export const trackObject = trackers.trackObject;
export const trackObjectCreate = trackers.trackObjectCreate;
export const trackObjectUpdate = trackers.trackObjectUpdate;
export const trackObjectDelete = trackers.trackObjectDelete;

const lineageHelpers = createLineageHelpers(
  browserProvider,
  lineageStore,
  objectStore,
  getCausalityConfig,
);
export const withLineage = lineageHelpers.withLineage;
export const runWithLineage = lineageHelpers.runWithLineage;

export type { TrackObjectInput, ObjectAction } from "./causality.js";

// ── WebSocket connection ─────────────────────────────────────────────

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
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      drainBuffer();
    };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
    ws.onerror = () => {};
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(); }, 2000);
}

// ── Span buffer + idle flush ─────────────────────────────────────────

const MAX_BATCH_SIZE = 100;
let buffer: Span[] = [];
let idleScheduled = false;

function bufferSpan(span: Span): void {
  buffer.push(span);
  if (buffer.length >= MAX_BATCH_SIZE) { drainBuffer(); return; }
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
  try { ws.send(JSON.stringify(batch)); } catch {}
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeObjectTypes(input: unknown[]): string[] {
  return [...new Set(
    input
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  )];
}

function readDefinedString(symbolName: string): string | null {
  if (symbolName === "__FLIGHTBOX_BLAST_SCOPE_ID__") {
    return typeof __FLIGHTBOX_BLAST_SCOPE_ID__ === "string" ? __FLIGHTBOX_BLAST_SCOPE_ID__ : null;
  }
  return null;
}

function readDefinedStringArray(symbolName: string): string[] {
  if (symbolName === "__FLIGHTBOX_OBJECT_TYPES__") {
    if (typeof __FLIGHTBOX_OBJECT_TYPES__ === "undefined") return [];
    if (!Array.isArray(__FLIGHTBOX_OBJECT_TYPES__)) return [];
    return normalizeObjectTypes(__FLIGHTBOX_OBJECT_TYPES__);
  }
  return [];
}

// ── Auto-connect on import ───────────────────────────────────────────

connectWebSocket();
