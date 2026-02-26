/**
 * Generate sample traces to ~/.flightbox/traces/
 * Run with: node --import tsx scripts/generate-traces.ts
 */

import { __flightbox_wrap, configure, flush, startFlushing } from "../packages/sdk/src/index.js";

configure({
  enabled: true,
  flushBatchSize: 10000, // flush manually at end
  gitSha: "auto",
});

startFlushing();

// ─── Simulated app functions ───

const fetchUser = __flightbox_wrap(
  async function fetchUser(userId: string) {
    await sleep(Math.random() * 20 + 5);
    if (userId === "user-404") throw new Error("User not found");
    return { id: userId, name: `User ${userId}`, email: `${userId}@example.com` };
  },
  { name: "fetchUser", module: "app/users.ts", line: 10 },
);

const validateOrder = __flightbox_wrap(
  function validateOrder(order: { items: string[]; userId: string }) {
    if (order.items.length === 0) throw new Error("Order must have items");
    if (!order.userId) throw new Error("Order must have a userId");
    return { ...order, validated: true };
  },
  { name: "validateOrder", module: "app/orders.ts", line: 5 },
);

const calculateTotal = __flightbox_wrap(
  function calculateTotal(items: string[]) {
    const prices: Record<string, number> = {
      widget: 9.99,
      gadget: 24.99,
      doohickey: 14.99,
      thingamajig: 39.99,
    };
    return items.reduce((sum, item) => sum + (prices[item] ?? 5.0), 0);
  },
  { name: "calculateTotal", module: "app/orders.ts", line: 15 },
);

const chargePayment = __flightbox_wrap(
  async function chargePayment(userId: string, amount: number) {
    await sleep(Math.random() * 50 + 10);
    if (amount > 100) throw new Error("Payment declined: amount too large");
    return { transactionId: `txn-${Date.now()}`, amount, status: "charged" };
  },
  { name: "chargePayment", module: "app/payments.ts", line: 3 },
);

const sendConfirmation = __flightbox_wrap(
  async function sendConfirmation(userId: string, orderId: string) {
    await sleep(Math.random() * 15 + 5);
    return { sent: true, to: `${userId}@example.com` };
  },
  { name: "sendConfirmation", module: "app/notifications.ts", line: 8 },
);

const processOrder = __flightbox_wrap(
  async function processOrder(userId: string, items: string[]) {
    const user = await fetchUser(userId);
    const validated = validateOrder({ items, userId: user.id });
    const total = calculateTotal(validated.items);
    const payment = await chargePayment(userId, total);
    const orderId = `order-${Date.now()}`;
    await sendConfirmation(userId, orderId);
    return { orderId, total, payment, user };
  },
  { name: "processOrder", module: "app/orders.ts", line: 30 },
);

const handleRequest = __flightbox_wrap(
  async function handleRequest(path: string, body: unknown) {
    if (path === "/api/orders") {
      const { userId, items } = body as { userId: string; items: string[] };
      return await processOrder(userId, items);
    }
    throw new Error(`Unknown path: ${path}`);
  },
  { name: "handleRequest", module: "app/server.ts", line: 1 },
);

// ─── Generate traces ───

async function main() {
  console.log("Generating traces to ~/.flightbox/traces/ ...\n");

  // Trace 1: Successful order
  console.log("1. Successful order (widget + gadget)...");
  try {
    const result = await handleRequest("/api/orders", {
      userId: "user-42",
      items: ["widget", "gadget"],
    });
    console.log("   OK:", JSON.stringify(result).slice(0, 100));
  } catch (e: any) {
    console.log("   ERROR:", e.message);
  }

  // Trace 2: Another successful order
  console.log("2. Successful order (doohickey)...");
  try {
    const result = await handleRequest("/api/orders", {
      userId: "user-99",
      items: ["doohickey"],
    });
    console.log("   OK:", JSON.stringify(result).slice(0, 100));
  } catch (e: any) {
    console.log("   ERROR:", e.message);
  }

  // Trace 3: User not found error
  console.log("3. User not found error...");
  try {
    await handleRequest("/api/orders", {
      userId: "user-404",
      items: ["widget"],
    });
  } catch (e: any) {
    console.log("   ERROR:", e.message);
  }

  // Trace 4: Payment declined (amount too large)
  console.log("4. Payment declined (too many items)...");
  try {
    await handleRequest("/api/orders", {
      userId: "user-1",
      items: ["thingamajig", "thingamajig", "thingamajig"],
    });
  } catch (e: any) {
    console.log("   ERROR:", e.message);
  }

  // Trace 5: Empty order validation error
  console.log("5. Empty order validation error...");
  try {
    await handleRequest("/api/orders", {
      userId: "user-1",
      items: [],
    });
  } catch (e: any) {
    console.log("   ERROR:", e.message);
  }

  // Trace 6: Unknown route
  console.log("6. Unknown route error...");
  try {
    await handleRequest("/api/unknown", {});
  } catch (e: any) {
    console.log("   ERROR:", e.message);
  }

  // Flush all spans to disk
  await flush();

  console.log("\nDone! Traces written to ~/.flightbox/traces/");
  console.log("Now configure the MCP server in your Claude Code settings.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
