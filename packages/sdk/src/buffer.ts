import type { Span } from "@flightbox/core";
import { getConfig } from "./config.js";
import { flushToParquet } from "./flush.js";

let buffer: Span[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

export function bufferSpan(span: Span): void {
  buffer.push(span);

  const cfg = getConfig();
  if (buffer.length >= cfg.flushBatchSize) {
    void drain();
  }
}

export function startFlushing(): void {
  if (flushTimer) return;
  const cfg = getConfig();
  flushTimer = setInterval(() => void drain(), cfg.flushIntervalMs);
  flushTimer.unref(); // Don't keep the process alive

  process.on("beforeExit", onShutdown);
  process.on("SIGTERM", onShutdown);
  process.on("SIGINT", onShutdown);
}

export function stopFlushing(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

async function drain(): Promise<void> {
  if (buffer.length === 0) return;

  const batch = buffer;
  buffer = [];

  try {
    const cfg = getConfig();
    await flushToParquet(batch, cfg.tracesDir);
  } catch (err) {
    // On flush failure, put spans back (best-effort)
    buffer.unshift(...batch);
    if (process.env.FLIGHTBOX_DEBUG) {
      console.error("[flightbox] flush error:", err);
    }
  }
}

async function onShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  stopFlushing();
  await drain();
}

export { drain as flush };
