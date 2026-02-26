export { __flightbox_wrap } from "./wrap.js";
export { configure, getConfig } from "./config.js";
export { startFlushing, stopFlushing, flush } from "./buffer.js";
export { storage } from "./context.js";
export {
  trackEntity,
  trackEntityCreate,
  trackEntityUpdate,
  trackEntityDelete,
} from "./entity.js";
export type { EntityAction, TrackEntityInput } from "./entity.js";

// Auto-start flushing on import — zero config needed
import { startFlushing as _start } from "./buffer.js";
_start();
