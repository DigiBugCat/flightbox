# Flightbox

Passive causality tracing for dev-time debugging.

## The problem

You ask an LLM to build a feature. It writes code across several files — handlers, services, utilities. Something breaks. Now what?

You didn't write the code, so you don't have a mental model of it. You can't just "think through" where the bug is. You paste the error back to the LLM, it guesses, you go back and forth. Maybe it fixes it, maybe it makes it worse.

The issue isn't that the LLM can't debug — it's that it can't *see*. It wrote the code but has no idea what actually happened at runtime. What got called, with what arguments, what came back, where it blew up.

## What Flightbox does

Flightbox records function execution — arguments, return values, errors, timing, parent-child relationships, and object state — then writes it to Parquet files. An MCP server reads those files and exposes tools that let an LLM walk the execution trace, detect patterns, and track object state changes.

No reproduction needed. The LLM doesn't have to guess what happened. It can look.

```
Your app (instrumented)          Claude / any MCP client
  │                                │
  │ functions run normally         │ "why did checkout fail?"
  │ spans get recorded             │
  │                                │ calls flightbox_failing
  ▼                                │ → finds the error span
~/.flightbox/traces/*.parquet      │ calls flightbox_walk
  │                                │ → traces up to the root cause
  │         DuckDB reads ──────────│ calls flightbox_inspect
  │                                │ → sees the bad input
  │                                ▼
  │                              "the shipping calculator got
  │                               null instead of an address
  │                               because fetchUser returned
  │                               early on line 42"
```

There's no daemon. The SDK writes Parquet files to a directory. The MCP server reads them with DuckDB. They never talk to each other — they share a filesystem.

## Quick start

### 1. Instrument your app

**Option A: Loader hook (Node.js, recommended)** — works with tsx, ts-node, plain node. Zero config.

```bash
npm install @flightbox/register @flightbox/sdk
node --import @flightbox/register ./src/index.ts
```

Every function in your code gets instrumented automatically. No Babel, no build config.

**Option B: Vite plugin (browser + Node)** — auto-instruments your code and captures browser traces via WebSocket.

```bash
npm install @flightbox/unplugin @flightbox/sdk
```

```ts
// vite.config.ts
import flightbox from '@flightbox/unplugin/vite'

export default {
  plugins: [
    flightbox({
      include: ['**/renderer/**'],
      objects: { types: ['AGENT', 'ROOM', 'ITEM'] },
      lineage: { maxHops: 2 },
    }),
  ],
}
```

This does four things:
1. **Scopes** instrumentation to recently changed files via `git diff` — only traces code in your blast radius
2. **Transforms** those files to wrap functions with tracing
3. **Aliases** `@flightbox/sdk` → `@flightbox/sdk/browser` so the browser gets a lightweight SDK
4. **Starts a WebSocket collector** on the Vite dev server that writes browser spans to Parquet

**Option C: Other bundlers** — webpack, esbuild, Rollup (transform only, no browser collection).

```js
// webpack
import flightbox from '@flightbox/unplugin/webpack'
// esbuild
import flightbox from '@flightbox/unplugin/esbuild'
// rollup
import flightbox from '@flightbox/unplugin/rollup'
```

### 2. Add the MCP server

```json
{
  "mcpServers": {
    "flightbox": {
      "command": "npx",
      "args": ["@flightbox/mcp-server"]
    }
  }
}
```

### 3. Run your app, then ask questions

Run your app normally. When something breaks, ask the LLM:

> "Why did checkout fail?"

It will use the MCP tools to find the error, trace the call chain, and inspect the arguments that caused the problem.

---

## Wiring guide

Flightbox instruments functions automatically, but to get the most out of it you'll want to wire up three things: **object tracking**, **annotations**, and **cross-boundary lineage**.

### Object tracking

When your code creates, updates, or deletes domain entities, annotate those mutation points:

```ts
import {
  trackObjectCreate,
  trackObjectUpdate,
  trackObjectDelete,
} from '@flightbox/sdk'

// On entity creation — pass the full snapshot
trackObjectCreate('AGENT', agent.id, agent)

// On entity update — pass the current state as snapshot
// The MCP server computes diffs automatically via LAG() at query time
trackObjectUpdate('AGENT', agent.id, undefined, {
  x: agent.position.x,
  y: agent.position.y,
  state: agent.state,
})

// If you already have a diff (e.g. from ECS dirty tracking), pass it as changes
trackObjectUpdate('AGENT', agent.id, {
  position: { from: { x: 61, y: 54 }, to: { x: 61, y: 55 } },
  state: { from: 'MOVING', to: 'IDLE' },
})

// On entity deletion
trackObjectDelete('AGENT', agent.id, agent)
```

Signature: `trackObjectUpdate(entityType, entityId?, changes?, snapshot?, dimensions?)`

- **snapshot**: The current state of the entity. Stored as-is. The MCP server computes `{field: {from, to}}` diffs between consecutive snapshots at query time — you don't need to compute diffs yourself.
- **changes**: Optional explicit diff if you already have one. Takes priority over snapshot-based diffs when present.
- **dimensions**: Optional flat key-value metadata (e.g. `{ zone: "north", frame: 1234 }`).

This gives the MCP server structured entity timelines:

```
flightbox_object_timeline(object_type: "AGENT", object_id: "marcus", field_filter: "position")

→ [
    { at: 1772150100, action: "update",
      snapshot: { x: 61, y: 55, state: "IDLE" },
      diff: { x: { from: 62, to: 61 }, state: { from: "MOVING", to: "IDLE" } },
      span_id: "abc123", function: "handleMovement" },
    ...
  ]
```

The `field_filter` param narrows to events where a specific field changed — e.g. only position changes, ignoring mood/needs/scratchpad noise.

### Annotations

For lightweight key-value metadata on the current span — decision branches, scoring results, debug flags:

```ts
import { annotate } from '@flightbox/sdk'

// Inside a state machine switch:
annotate('branch', sm.state)

// Inside a scoring function:
annotate('winner', { activity: winner.id, score: winner.score })

// Debug flag:
annotate('cache_hit', false)
```

`annotate(key, value)` appends to `span.tags.annotations`. No-op when no active span. Queryable via:

```sql
SELECT * FROM spans
WHERE json_extract_string(tags, '$.annotations.branch') = 'IDLE'
```

### Cross-boundary lineage

To trace causality across process boundaries (server → client, service → service), use the transport adapter:

```ts
import { createTransportLineageAdapter } from '@flightbox/sdk'

const lineage = createTransportLineageAdapter()

// Server: stamp outbound messages
ws.send(JSON.stringify(lineage.stamp({ kind: 'tick', delta })))

// Client: inject inbound causality
const msg = JSON.parse(event.data)
lineage.receive(msg, () => {
  applyDelta(msg.delta)
})
```

Or use the lower-level primitives directly:

```ts
import { withLineage, runWithLineage } from '@flightbox/sdk'

// Sender — stamps lineage metadata into payload
ws.send(JSON.stringify(withLineage({ type: 'pawn:update', delta })))

// Receiver — injects remote context
const msg = JSON.parse(event.data)
runWithLineage(msg, () => {
  applyDelta(msg.delta)
})
```

Lineage attachment requires:
1. Current span must have touched a tracked object type.
2. If `lineage.requireBlastScope=true` (default), current span must be in blast scope.
3. Missing or invalid lineage is a safe no-op — never breaks your code.

---

## MCP tools

**`@flightbox/mcp-server`** — 15 tools over MCP:

### Trace navigation

| Tool | What it does |
|------|-------------|
| `flightbox_summary` | Entry point. Shows trace overview — root span, total spans, slowest, errors. |
| `flightbox_children` | Drill into a span's children. What did this function call? |
| `flightbox_inspect` | Full detail on one span — serialized args, return value, error + stack. |
| `flightbox_walk` | Walk up or down the causal graph from any span (call edges + lineage edges). |
| `flightbox_search` | Find spans by function name, text in args/output/errors, duration, etc. |
| `flightbox_recent` | Polling-friendly incremental feed. Fetch spans since a cursor. |
| `flightbox_siblings` | Everything that ran under the same parent, in execution order. |
| `flightbox_failing` | Recent errors, grouped by error type. |

### Object tracking

| Tool | What it does |
|------|-------------|
| `flightbox_objects` | Object-level summary with coverage report (configured vs observed types). |
| `flightbox_object_timeline` | Time-ordered object mutations with snapshots, computed diffs, span anchors, and cross-process links. Supports `field_filter` to narrow to specific field changes. |

### Pattern detection

| Tool | What it does |
|------|-------------|
| `flightbox_hotspots` | Functions called most frequently. Finds spam calls and hot loops. |
| `flightbox_input_stability` | Functions called repeatedly with identical input. Finds wasted work. |
| `flightbox_intervals` | Timing between consecutive calls. Detects tick rate mismatches. |
| `flightbox_oscillation` | Detects values ping-ponging between states (A→B→A→B). Works on object snapshots or raw span inputs. |

### Raw SQL

| Tool | What it does |
|------|-------------|
| `flightbox_query` | Arbitrary DuckDB SQL against `spans`. Full power — aggregations, JSON extraction, window functions, CTEs. |

### Example: debugging a state machine oscillation

This is the actual workflow that diagnosed a pawn oscillation bug in a game:

```
1. flightbox_hotspots(last_n_minutes: 1)
   → buildPixelPath at 8K calls/min (should be ~3.6K at 60fps)

2. flightbox_input_stability(name_pattern: "buildPixelPath", last_n_minutes: 1)
   → Same input repeated 27 times — pathChanged firing when nothing changed

3. flightbox_object_timeline(object_type: "AGENT", object_id: "marcus", field_filter: "position")
   → Position alternating between y=54 and y=55 every few frames

4. flightbox_oscillation(object_type: "AGENT", field_path: "position.y")
   → Marcus flagged with 24 flip events — server reassigning jobs that bounce him

5. flightbox_walk(span_id: <mutation_span>, direction: "up")
   → progressJob → move_to_agent → ensurePath on every flip
```

---

## Dynamic blast radius

By default, the Vite plugin only instruments files changed in recent git commits. To temporarily expand scope during debugging:

```bash
# Add patterns alongside git scoping
FLIGHTBOX_INCLUDE="**/stateMachineSystem**,**/pathfinding/**" npm run dev

# Replace git scoping entirely with explicit patterns
FLIGHTBOX_ONLY="**/stateMachine**,**/renderer/**" npm run dev
```

Both env vars work with the Node loader hook too:

```bash
FLIGHTBOX_INCLUDE="**/stateMachine**" node --import @flightbox/register ./app.ts
```

---

## What gets captured

Each function call produces a span:

- **span_id / trace_id / parent_id** — the call tree structure
- **name, module, file_line** — where in your code
- **input** — JSON-serialized arguments (depth-limited, truncated)
- **output** — JSON-serialized return value
- **error** — JSON-serialized error with stack trace
- **context** — JSON-serialized `this` for class methods (depth 1, primitives prioritized). `null` for non-method calls.
- **tags** — structured metadata: object mutations, lineage send/recv, blast scope, annotations
- **started_at / ended_at / duration_ms** — timing
- **git_sha** — which commit

### Serialization

Serialization is depth-limited (5 levels), breadth-limited (10 complex values per object/array), and string-truncated (512 chars). Circular references are detected. Primitive values (strings, numbers, booleans) are always included regardless of the breadth limit — only objects and arrays count against it.

---

## Configuration

### Loader hook — env vars

```bash
FLIGHTBOX_INCLUDE="src/**/*.ts" node --import @flightbox/register ./app.ts
FLIGHTBOX_ONLY="src/systems/**" node --import @flightbox/register ./app.ts
FLIGHTBOX_EXCLUDE="**/*.test.ts" node --import @flightbox/register ./app.ts
```

### Vite plugin — options

```ts
flightbox({
  include: ['**/renderer/**'],
  exclude: ['**/test/**'],
  objects: { types: ['AGENT', 'ROOM', 'ITEM'] },
  lineage: { maxHops: 2 },
})
```

### SDK — runtime configuration

```ts
import { configure } from '@flightbox/sdk'

configure({
  enabled: true,
  tracesDir: '~/.flightbox/traces',
  flushIntervalMs: 5000,
  objectCatalog: { types: ['AGENT', 'ROOM'] },
  lineage: {
    maxHops: 2,
    requireBlastScope: true,
    messageKey: '_fb',
  },
})
```

---

## Packages

| Package | What | npm |
|---------|------|-----|
| `@flightbox/register` | Node.js loader hook | [![npm](https://img.shields.io/npm/v/@flightbox/register)](https://www.npmjs.com/package/@flightbox/register) |
| `@flightbox/unplugin` | Build plugin (Vite/webpack/esbuild/Rollup) | [![npm](https://img.shields.io/npm/v/@flightbox/unplugin)](https://www.npmjs.com/package/@flightbox/unplugin) |
| `@flightbox/sdk` | Runtime SDK (Node + browser) | [![npm](https://img.shields.io/npm/v/@flightbox/sdk)](https://www.npmjs.com/package/@flightbox/sdk) |
| `@flightbox/mcp-server` | MCP query tools | [![npm](https://img.shields.io/npm/v/@flightbox/mcp-server)](https://www.npmjs.com/package/@flightbox/mcp-server) |
| `@flightbox/core` | Shared types & serializer | [![npm](https://img.shields.io/npm/v/@flightbox/core)](https://www.npmjs.com/package/@flightbox/core) |
| `@flightbox/babel-plugin` | Babel transform (legacy) | [![npm](https://img.shields.io/npm/v/@flightbox/babel-plugin)](https://www.npmjs.com/package/@flightbox/babel-plugin) |

## Architecture

```
Browser (main thread)              Vite dev server            MCP server
  │                                    │                         │
  │ wrapped fn runs → span recorded    │                         │
  │ buffer.push(span)                  │                         │
  │   ...more functions...             │                         │
  │ requestIdleCallback fires          │                         │
  │   JSON.stringify(batch)            │                         │
  │   ws.send(json) ──────────────────→│ JSON.parse              │
  │                                    │ batch append (DuckDB)   │
  │                                    │ every 500ms:            │
  │                                    │   flush → .parquet      │
  │                                    │   ~/.flightbox/traces/  │──→ queries
```

## License

MIT
