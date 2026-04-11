/**
 * No Ollama required: verifies local LLM + terse/caveman prompt wiring.
 * Run: npm run test:terse-prompt
 */
process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || "http://127.0.0.1:11434/v1";
process.env.LLM_API_KEY = process.env.LLM_API_KEY || "ollama";
process.env.MERIDIAN_CAVEMAN = process.env.MERIDIAN_CAVEMAN || "1";

const { config, isTerseCavemanLive } = await import("../config.js");
const { buildSystemPrompt } = await import("../prompt.js");

if (!config.llm.isLocalEndpoint) {
  console.error("FAIL: expected isLocalEndpoint (set LLM_BASE_URL to non-OpenRouter, e.g. Ollama)");
  process.exit(1);
}
if (!isTerseCavemanLive()) {
  console.error("FAIL: expected terse mode live (MERIDIAN_CAVEMAN=1)");
  process.exit(1);
}
const { getMeridianCavemanRuntimeLevel } = await import("../prompt.js");
if (getMeridianCavemanRuntimeLevel() === "off") {
  console.error("FAIL: expected caveman level not off (MERIDIAN_CAVEMAN=1 or local terse)");
  process.exit(1);
}
const p = buildSystemPrompt("SCREENER", { sol: 1 }, { total_positions: 0, positions: [] }, {}, null, null);
if (!p.includes("MERIDIAN CAVEMAN")) {
  console.error("FAIL: prompt missing MERIDIAN CAVEMAN block");
  process.exit(1);
}
console.log("OK — caveman runtime block present, level", getMeridianCavemanRuntimeLevel(), "length", p.length);
