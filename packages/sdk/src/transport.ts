/**
 * Transport lineage adapter — one-time wrapper for send/receive integration points.
 *
 * Usage:
 *   const adapter = createTransportLineageAdapter();
 *
 *   // On send:
 *   ws.send(JSON.stringify(adapter.stamp({ kind: "tick", ...delta })));
 *
 *   // On receive:
 *   adapter.receive(message, () => applyDelta(message));
 */
import { withLineage, runWithLineage } from "./wrap.js";

export interface TransportAdapter<TEnvelope extends Record<string, unknown>> {
  /** Stamp lineage metadata into the outbound envelope. */
  stamp(envelope: TEnvelope): TEnvelope;
  /** Inject remote causality context from the inbound envelope, then run fn. */
  receive<T>(envelope: TEnvelope, fn: () => T): T;
}

export function createTransportLineageAdapter<
  TEnvelope extends Record<string, unknown>,
>(opts?: { key?: string }): TransportAdapter<TEnvelope> {
  return {
    stamp: (envelope) => withLineage(envelope, opts),
    receive: (envelope, fn) => runWithLineage(envelope, fn, opts),
  };
}
