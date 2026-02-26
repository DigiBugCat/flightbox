import { unplugin } from "./index.js";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Span } from "@flightbox/core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import type { Plugin } from "vite";
import type { FlightboxPluginOptions } from "./index.js";

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
  private counter = 0;
  private instance: InstanceType<typeof DuckDBInstance> | null = null;

  constructor(private tracesDir: string) {
    mkdirSync(tracesDir, { recursive: true });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    this.instance = await DuckDBInstance.create(":memory:");
    const conn = await this.instance.connect();
    await conn.run(SCHEMA_SQL);

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  push(span: Span): void {
    this.buffer.push(span);
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.instance) return;
    await this.ready;

    const batch = this.buffer;
    this.buffer = [];

    const conn = await this.instance.connect();

    try {
      const appender = await conn.createAppender("spans");

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

      await conn.run(
        `COPY spans TO '${filepath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
      );
      await conn.run("DELETE FROM spans");
    } catch (err) {
      if (process.env.FLIGHTBOX_DEBUG) {
        console.error("[flightbox] parquet flush error:", err);
      }
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}

// ── Vite plugin ───────────────────────────────────────────────────────

export default function flightbox(options?: FlightboxPluginOptions): Plugin[] {
  const tracesDir = join(homedir(), ".flightbox", "traces");

  // Re-use the unplugin transform as a Vite plugin
  const transformPlugin = unplugin.vite(options) as Plugin;

  const serverPlugin: Plugin = {
    name: "flightbox:server",

    config() {
      return {
        resolve: {
          alias: {
            "@flightbox/sdk": "@flightbox/sdk/browser",
          },
        },
      };
    },

    configureServer(server) {
      const writer = new ParquetWriter(tracesDir);

      const wss = new WebSocketServer({ noServer: true });

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
