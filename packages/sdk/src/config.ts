import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export interface EntityCatalogConfig {
  types: string[];
}

export interface LineageConfig {
  maxHops: number;
  requireBlastScope: boolean;
  messageKey: string;
}

export interface SdkConfig {
  enabled: boolean;
  tracesDir: string;
  flushIntervalMs: number;
  flushBatchSize: number;
  serializationDepth: number;
  gitSha: string | null;
  blastScopeId: string | null;
  entityCatalog: EntityCatalogConfig;
  lineage: LineageConfig;
}

export interface SdkConfigOverrides
  extends Partial<Omit<SdkConfig, "entityCatalog" | "lineage">> {
  gitSha?: string | "auto";
  entityCatalog?: Partial<EntityCatalogConfig>;
  lineage?: Partial<LineageConfig>;
}

const defaultConfig: SdkConfig = {
  enabled: true,
  tracesDir: join(homedir(), ".flightbox", "traces"),
  flushIntervalMs: 5000,
  flushBatchSize: 1000,
  serializationDepth: 5,
  gitSha: null,
  blastScopeId: process.env.FLIGHTBOX_BLAST_SCOPE_ID ?? null,
  entityCatalog: {
    types: parseEntityTypesEnv(),
  },
  lineage: {
    maxHops: 2,
    requireBlastScope: true,
    messageKey: "_fb",
  },
};

let config: SdkConfig = { ...defaultConfig };

export function configure(overrides: SdkConfigOverrides): void {
  const { gitSha, entityCatalog, lineage, ...rest } = overrides;
  Object.assign(config, rest);

  if (entityCatalog) {
    config.entityCatalog = {
      ...config.entityCatalog,
      ...entityCatalog,
      types: normalizeEntityTypes(entityCatalog.types ?? config.entityCatalog.types),
    };
  }

  if (lineage) {
    config.lineage = {
      ...config.lineage,
      ...lineage,
    };
  }

  if (gitSha === "auto") {
    config.gitSha = detectGitSha();
  } else if (gitSha !== undefined) {
    config.gitSha = gitSha;
  }
}

export function getConfig(): SdkConfig {
  return config;
}

function detectGitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

function parseEntityTypesEnv(): string[] {
  const raw = process.env.FLIGHTBOX_ENTITY_TYPES;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return normalizeEntityTypes(parsed);
  } catch {
    // fall through to CSV parsing
  }

  return normalizeEntityTypes(raw.split(","));
}

function normalizeEntityTypes(input: unknown[]): string[] {
  return [...new Set(
    input
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  )];
}
