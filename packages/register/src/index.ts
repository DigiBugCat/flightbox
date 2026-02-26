import { register } from "node:module";

// hooks.js must be plain JS — the hooks worker thread doesn't have tsx
register("./hooks.js", import.meta.url);
