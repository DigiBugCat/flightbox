import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SdkConfig {
  enabled: boolean;
  tracesDir: string;
  flushIntervalMs: number;
  flushBatchSize: number;
  serializationDepth: number;
  gitSha: string | null;
}

const defaultConfig: SdkConfig = {
  enabled: true,
  tracesDir: join(homedir(), ".flightbox", "traces"),
  flushIntervalMs: 5000,
  flushBatchSize: 1000,
  serializationDepth: 5,
  gitSha: null,
};

let config: SdkConfig = { ...defaultConfig };

export function configure(
  overrides: Partial<SdkConfig> & { gitSha?: string | "auto" },
): void {
  const { gitSha, ...rest } = overrides;
  Object.assign(config, rest);

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
