import type { SpanContext } from "@flightbox/core";
import { storage } from "./context.js";
import { getConfig } from "./config.js";
import { bufferSpan } from "./buffer.js";
import {
  createWrap,
  createEntityStore,
  createLineageStore,
  createEntityTrackers,
  createLineageHelpers,
  type ContextProvider,
  type CausalityConfig,
} from "./causality.js";

// Node context provider — delegates to AsyncLocalStorage
const nodeProvider: ContextProvider = {
  extract: () => storage.getStore(),
  inject: <T>(ctx: SpanContext, fn: () => T): T => storage.run(ctx, fn),
};

// Shared stores for the Node runtime
export const entityStore = createEntityStore();
export const lineageStore = createLineageStore();

function getCausalityConfig(): CausalityConfig {
  const cfg = getConfig();
  return {
    enabled: cfg.enabled,
    blastScopeId: cfg.blastScopeId,
    gitSha: cfg.gitSha,
    entityCatalog: cfg.entityCatalog,
    lineage: cfg.lineage,
  };
}

export const __flightbox_wrap = createWrap(
  nodeProvider,
  entityStore,
  lineageStore,
  getCausalityConfig,
  bufferSpan,
);

// Re-export entity trackers bound to node provider + store
const trackers = createEntityTrackers(nodeProvider, entityStore);
export const trackEntity = trackers.trackEntity;
export const trackEntityCreate = trackers.trackEntityCreate;
export const trackEntityUpdate = trackers.trackEntityUpdate;
export const trackEntityDelete = trackers.trackEntityDelete;

// Re-export lineage helpers bound to node provider + stores
const lineageHelpers = createLineageHelpers(
  nodeProvider,
  lineageStore,
  entityStore,
  getCausalityConfig,
);
export const withLineage = lineageHelpers.withLineage;
export const runWithLineage = lineageHelpers.runWithLineage;
