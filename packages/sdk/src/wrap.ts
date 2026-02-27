import type { SpanContext } from "@flightbox/core";
import { storage } from "./context.js";
import { getConfig } from "./config.js";
import { bufferSpan } from "./buffer.js";
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

// Node context provider — delegates to AsyncLocalStorage
const nodeProvider: ContextProvider = {
  extract: () => storage.getStore(),
  inject: <T>(ctx: SpanContext, fn: () => T): T => storage.run(ctx, fn),
};

// Shared stores for the Node runtime
export const objectStore = createObjectStore();
export const lineageStore = createLineageStore();
export const annotationStore = createAnnotationStore();

function getCausalityConfig(): CausalityConfig {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    blastScopeId: cfg.blastScopeId,
    gitSha: cfg.gitSha,
    objectCatalog: cfg.objectCatalog,
    lineage: cfg.lineage,
  };
}

export const __flightbox_wrap = createWrap(
  nodeProvider,
  objectStore,
  lineageStore,
  getCausalityConfig,
  bufferSpan,
  annotationStore,
);

// Re-export entity trackers bound to node provider + store
const trackers = createObjectTrackers(nodeProvider, objectStore);
export const trackObject = trackers.trackObject;
export const trackObjectCreate = trackers.trackObjectCreate;
export const trackObjectUpdate = trackers.trackObjectUpdate;
export const trackObjectDelete = trackers.trackObjectDelete;

// Re-export lineage helpers bound to node provider + stores
const lineageHelpers = createLineageHelpers(
  nodeProvider,
  lineageStore,
  objectStore,
  getCausalityConfig,
);
export const withLineage = lineageHelpers.withLineage;
export const runWithLineage = lineageHelpers.runWithLineage;

// Annotate API
export const annotate = createAnnotate(nodeProvider, annotationStore);
