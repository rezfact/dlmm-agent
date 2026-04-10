/**
 * Smoke-test Ollama’s OpenAI-compatible API (same path Meridian uses).
 *
 * On the host (Ollama on localhost:11434):
 *   LLM_BASE_URL=http://127.0.0.1:11434/v1 npm run test:ollama
 *
 * Meridian in Docker (Ollama on host :11434):
 *   npm run test:docker-ollama-host
 *
 * Fully isolated Ollama in Docker (large image pull first):
 *   npm run test:docker-ollama
 */

import "dotenv/config";
import OpenAI from "openai";

const baseURL = process.env.LLM_BASE_URL || "http://127.0.0.1:11434/v1";
const apiKey = process.env.LLM_API_KEY || "ollama";
const model =
  process.env.LLM_MODEL ||
  process.env.LLM_LOCAL_MODEL ||
  "qwen2.5:3b";

async function main() {
  console.log("test:ollama — baseURL:", baseURL, "| model:", model);
  const client = new OpenAI({ baseURL, apiKey, timeout: 120_000 });
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: 'Reply with exactly: OLLAMA_OK' }],
    max_tokens: 32,
    temperature: 0,
  });
  const text = res.choices?.[0]?.message?.content?.trim() || "";
  console.log("response:", text);
  if (!text.includes("OLLAMA_OK")) {
    console.error("FAIL: expected substring OLLAMA_OK in reply");
    process.exit(1);
  }
  console.log("OK — Meridian can use this Ollama endpoint.");
}

main().catch((e) => {
  console.error("FAIL:", e.message || e);
  process.exit(1);
});
