import { AsyncLocalStorage } from "node:async_hooks";
import type { SpanContext } from "@flightbox/core";

export const storage = new AsyncLocalStorage<SpanContext>();
