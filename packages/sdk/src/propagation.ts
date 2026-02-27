import type { SpanContext } from "@flightbox/core";
import { storage } from "./context.js";

export function extract(): SpanContext | undefined {
  return storage.getStore();
}

export function inject<T>(context: SpanContext, fn: () => T): T {
  return storage.run(context, fn);
}
