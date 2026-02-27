import { execSync } from "node:child_process";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export interface ObjectCatalogConfig {
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
  objectCatalog: ObjectCatalogConfig;
  lineage: LineageConfig;
}

export interface SdkConfigOverrides
  extends Partial<Omit<SdkConfig, "objectCatalog" | "lineage">> {
  gitSha?: string | "auto";
  objectCatalog?: Partial<ObjectCatalogConfig>;
  lineage?: Partial<LineageConfig>;
}

const defaultConfig: SdkConfig = {
  enabled: true,
  tracesDir: detectProjectTracesDir(),
  flushIntervalMs: 5000,
  flushBatchSize: 1000,
  serializationDepth: 5,
  gitSha: null,
  blastScopeId: process.env.FLIGHTBOX_BLAST_SCOPE_ID ?? null,
  objectCatalog: {
    types: parseObjectTypesEnv(),
  },
  lineage: {
    maxHops: 2,
    requireBlastScope: true,
    messageKey: "_fb",
  },
};

let config: SdkConfig = { ...defaultConfig };

export function configure(overrides: SdkConfigOverrides): void {
  const { gitSha, objectCatalog, lineage, ...rest } = overrides;
  Object.assign(config, rest);

  if (objectCatalog) {
    config.objectCatalog = {
      ...config.objectCatalog,
      ...objectCatalog,
      types: normalizeObjectTypes(objectCatalog.types ?? config.objectCatalog.types),
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

function detectProjectTracesDir(): string {
  const base = join(homedir(), ".flightbox", "traces");
  const projectName = detectProjectName();
  if (projectName) return join(base, projectName);
  return base;
}

function detectProjectName(): string | null {
  // Try package.json name first
  try {
    const pkgPath = join(process.cwd(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg.name === "string" && pkg.name.trim()) {
        // Sanitize: @scope/name → scope-name, strip non-alphanumeric
        return pkg.name.replace(/^@/, "").replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "");
      }
    }
  } catch {}

  // Fall back to directory name
  return basename(process.cwd());
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

function parseObjectTypesEnv(): string[] {
  const raw = process.env.FLIGHTBOX_OBJECT_TYPES;
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return normalizeObjectTypes(parsed);
  } catch {
    // fall through to CSV parsing
  }

  return normalizeObjectTypes(raw.split(","));
}

function normalizeObjectTypes(input: unknown[]): string[] {
  return [...new Set(
    input
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  )];
}
