/**
 * Test the full agent loop in dry-run mode.
 * Run: DRY_RUN=true node test/test-agent.js
 * With DRY_RUN=true, deploy_position skips on-chain txs and skips SOL balance checks,
 * so an empty wallet is OK for this test.
 */

import "dotenv/config";
import { agentLoop } from "../agent.js";

async function main() {
  console.log("=== Testing Agent Loop (DRY RUN) ===\n");
  console.log("Goal: Discover top pools and recommend 3 LP opportunities\n");

  const result = await agentLoop(
    "Run get_top_candidates. Then deploy_position into the #1 candidate using 0.5 SOL (match min deploy). Report what was deployed.",
    5
  );

  console.log("\n=== Agent Response ===");
  console.log(result);
  console.log("\n=== Test complete ===");
}

main().catch(console.error);
