// Quick test: run with `tsx --import @flightbox/register ./scripts/test-register.ts`
// Should auto-instrument all functions and produce traces

function greet(name: string): string {
  return `Hello, ${name}!`;
}

async function fetchUser(id: number) {
  const greeting = greet(`User-${id}`);
  return { id, greeting };
}

const multiply = (a: number, b: number) => a * b;

async function main() {
  console.log("=== Flightbox Register Test ===");
  const user = await fetchUser(42);
  console.log("User:", user);
  console.log("Multiply:", multiply(3, 7));
  console.log("=== Done ===");
}

main();
