import { unplugin } from "./index.js";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { Span } from "@flightbox/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { WebSocketServer } from "ws";
import type { Plugin } from "vite";
import type { FlightboxPluginOptions } from "./index.js";
import { createHash } from "node:crypto";

// ── Parquet writer (batched, persistent DuckDB) ───────────────────────

const FLUSH_INTERVAL_MS = 500;
const FLUSH_BATCH_SIZE = 1000;

const SCHEMA_SQL = `
CREATE TABLE spans (
  span_id VARCHAR,
  trace_id VARCHAR,
  parent_id VARCHAR,
  kind VARCHAR,
  name VARCHAR,
  module VARCHAR,
  file_line VARCHAR,
  input VARCHAR,
  output VARCHAR,
  error VARCHAR,
  context VARCHAR,
  started_at BIGINT,
  ended_at BIGINT,
  duration_ms DOUBLE,
  git_sha VARCHAR,
  tags VARCHAR
)`;

class ParquetWriter {
  private ready: Promise<void>;
  private buffer: Span[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private counter = 0;
  private conn: DuckDBConnection | null = null;

  constructor(private tracesDir: string) {
    mkdirSync(tracesDir, { recursive: true });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const instance = await DuckDBInstance.create(":memory:");
    this.conn = await instance.connect();
    await this.conn.run(SCHEMA_SQL);

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  push(span: Span): void {
    this.buffer.push(span);
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;
    await this.ready;
    if (!this.conn) return;

    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];

    try {
      const appender = await this.conn.createAppender("spans");

      for (const s of batch) {
        appender.appendVarchar(s.span_id);
        appender.appendVarchar(s.trace_id);
        appender.appendVarchar(s.parent_id ?? "");
        appender.appendVarchar(s.kind);
        appender.appendVarchar(s.name);
        appender.appendVarchar(s.module);
        appender.appendVarchar(s.file_line);
        appender.appendVarchar(s.input ?? "");
        appender.appendVarchar(s.output ?? "");
        appender.appendVarchar(s.error ?? "");
        appender.appendVarchar(s.context ?? "");
        appender.appendBigInt(BigInt(s.started_at));
        appender.appendBigInt(BigInt(s.ended_at ?? 0));
        appender.appendDouble(s.duration_ms ?? 0);
        appender.appendVarchar(s.git_sha ?? "");
        appender.appendVarchar(s.tags ?? "");
        appender.endRow();
      }

      appender.flushSync();
      appender.closeSync();

      const filename = `${Date.now()}-browser-${this.counter++}.parquet`;
      const filepath = join(this.tracesDir, filename);

      await this.conn.run(
        `COPY spans TO '${filepath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
      );
      await this.conn.run("DELETE FROM spans");
    } catch (err) {
      if (process.env.FLIGHTBOX_DEBUG) {
        console.error("[flightbox] parquet flush error:", err);
      }
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}

// ── Env pattern parsing ───────────────────────────────────────────────

function parseEnvPatterns(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ── Git blast radius ──────────────────────────────────────────────────

function getGitChangedFiles(): string[] {
  try {
    const output = execSync("git diff --name-only HEAD~5 HEAD 2>/dev/null || git diff --name-only HEAD 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
    });
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && /\.[jt]sx?$/.test(f));
  } catch {
    return [];
  }
}

interface FlightboxManifest {
  generated_at: string;
  blast_scope_id: string;
  include_patterns: string[];
  env_include_patterns: string[];
  env_only_patterns: string[];
  declared_object_types: string[];
  lineage: {
    max_hops: number;
    require_blast_scope: true;
    message_key: "_fb";
  };
}

function computeBlastScopeId(
  includePatterns: string[],
  objectTypes: string[],
  maxHops: number,
): string {
  const hash = createHash("sha1")
    .update(JSON.stringify({
      includePatterns: [...includePatterns].sort(),
      objectTypes: [...objectTypes].sort(),
      maxHops,
    }))
    .digest("hex");
  return hash.slice(0, 16);
}

// ── Vite plugin ───────────────────────────────────────────────────────

export default function flightbox(options?: FlightboxPluginOptions): Plugin[] {
  const tracesDir = join(homedir(), ".flightbox", "traces");
  const declaredObjectTypes: string[] = [...new Set(
    (options?.objects?.types ?? [] as string[])
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 0),
  )];
  const maxHops = Math.max(1, Math.floor(options?.lineage?.maxHops ?? 2));

  // Build include patterns from git blast radius + explicit includes + env overrides
  const envInclude = parseEnvPatterns(process.env.FLIGHTBOX_INCLUDE);
  const envOnly = parseEnvPatterns(process.env.FLIGHTBOX_ONLY);
  const userInclude = options?.include ?? [];

  let gitFiles: string[] = [];
  let gitPatterns: string[] = [];
  let mergedInclude: string[];

  if (envOnly.length > 0) {
    // FLIGHTBOX_ONLY replaces git scoping entirely
    mergedInclude = [...envOnly, ...userInclude];
  } else {
    gitFiles = getGitChangedFiles();
    gitPatterns = gitFiles.map((f) => `**/${f}`);
    mergedInclude = [...gitPatterns, ...userInclude, ...envInclude];
  }

  const blastScopeId = computeBlastScopeId(mergedInclude, declaredObjectTypes, maxHops);

  const parts: string[] = [];
  if (envOnly.length > 0) {
    parts.push(`FLIGHTBOX_ONLY: ${envOnly.length} patterns (git scoping disabled)`);
  } else {
    if (gitFiles.length > 0) parts.push(`${gitFiles.length} git-changed files`);
    if (envInclude.length > 0) parts.push(`${envInclude.length} FLIGHTBOX_INCLUDE patterns`);
  }
  if (userInclude.length > 0) parts.push(`${userInclude.length} include patterns`);
  if (parts.length > 0) {
    console.log(`[flightbox] instrumenting ${parts.join(" + ")}`);
  }

  const mergedOptions: FlightboxPluginOptions = {
    ...options,
    include: mergedInclude.length > 0 ? mergedInclude : undefined,
  };

  // Re-use the unplugin transform as a Vite plugin
  const transformPlugin = unplugin.vite(mergedOptions) as Plugin;

  const serverPlugin: Plugin = {
    name: "flightbox:server",

    config() {
      return {
        resolve: {
          alias: {
            "@flightbox/sdk": "@flightbox/sdk/browser",
          },
        },
        define: {
          __FLIGHTBOX_BLAST_SCOPE_ID__: JSON.stringify(blastScopeId),
          __FLIGHTBOX_OBJECT_TYPES__: JSON.stringify(declaredObjectTypes),
        },
      };
    },

    configureServer(server) {
      const writer = new ParquetWriter(tracesDir);
      process.env.FLIGHTBOX_BLAST_SCOPE_ID = blastScopeId;
      process.env.FLIGHTBOX_OBJECT_TYPES = JSON.stringify(declaredObjectTypes);

      const manifest: FlightboxManifest = {
        generated_at: new Date().toISOString(),
        blast_scope_id: blastScopeId,
        include_patterns: mergedInclude,
        env_include_patterns: envInclude,
        env_only_patterns: envOnly,
        declared_object_types: declaredObjectTypes,
        lineage: {
          max_hops: maxHops,
          require_blast_scope: true,
          message_key: "_fb",
        },
      };
      const manifestDir = resolve(process.cwd(), ".flightbox");
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        join(manifestDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );

      const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

      server.httpServer?.on("upgrade", (req: any, socket: any, head: any) => {
        if (req.url === "/__flightbox") {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        }
      });

      wss.on("connection", (ws) => {
        if (process.env.FLIGHTBOX_DEBUG) {
          console.log("[flightbox] browser connected");
        }

        ws.on("message", (data: Buffer) => {
          try {
            const spans = JSON.parse(data.toString()) as Span[];
            for (const span of spans) {
              writer.push(span);
            }
          } catch (err) {
            if (process.env.FLIGHTBOX_DEBUG) {
              console.error("[flightbox] decode error:", err);
            }
          }
        });

        ws.on("error", (err) => {
          if (process.env.FLIGHTBOX_DEBUG) {
            console.error("[flightbox] ws error:", err.message);
          }
        });

        ws.on("close", () => {
          if (process.env.FLIGHTBOX_DEBUG) {
            console.log("[flightbox] browser disconnected");
          }
        });
      });

      // Clean up on server close
      server.httpServer?.on("close", () => {
        void writer.close();
        wss.close();
      });
    },
  };

  return [transformPlugin, serverPlugin];
}
