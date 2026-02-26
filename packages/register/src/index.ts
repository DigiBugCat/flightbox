import { register } from "node:module";

// hooks.js must be plain JS — the hooks worker thread doesn't have tsx
register("./hooks.js", import.meta.url);

// Re-export transform for use by @flightbox/unplugin
export { createTransformer, transform } from "./transform.js";
export type { TransformOptions, TransformResult } from "./transform.js";
