export { __flightbox_wrap } from "./wrap.js";
export { configure, getConfig } from "./config.js";
export { startFlushing, stopFlushing, flush } from "./buffer.js";
export { storage } from "./context.js";
export { extract, inject } from "./propagation.js";
export { withLineage, runWithLineage } from "./wrap.js";
export {
  trackObject,
  trackObjectCreate,
  trackObjectUpdate,
  trackObjectDelete,
} from "./wrap.js";
export { annotate } from "./wrap.js";
export { createTransportLineageAdapter } from "./transport.js";
export type { TransportAdapter } from "./transport.js";
export type { ObjectAction, TrackObjectInput } from "./causality.js";

// Auto-start flushing on import — zero config needed
import { startFlushing as _start } from "./buffer.js";
_start();
