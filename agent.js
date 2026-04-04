import OpenAI from "openai";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "update_config", "get_position_pnl", "get_my_positions", "set_position_note", "add_pool_note", "get_wallet_balance", "withdraw_liquidity", "add_liquidity", "list_strategies", "get_strategy", "set_active_strategy", "get_pool_detail", "get_token_info", "get_active_bin", "study_top_lpers"]);
// update_config omitted for SCREENER — avoids cron thrash + extra LLM/tool turns during screening
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "add_pool_note", "add_to_blacklist", "get_wallet_balance", "get_my_positions", "list_strategies", "get_strategy", "set_active_strategy", "swap_token", "add_liquidity", "study_top_lpers", "get_pool_detail"]);

function getToolsForRole(agentType) {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));
  return tools;
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";

/** True while any agentLoop is executing — crons skip new work to avoid interleaved steps / double screening. */
let _agentLoopActive = false;
export function isAgentLoopRunning() {
  return _agentLoopActive;
}

function isTransientLlmError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return (
    /unexpected end of json|invalid json|econnreset|etimedout|socket hang up|fetch failed|network|aborted/.test(
      msg
    ) || err?.code === "ECONNRESET"
  );
}

// Supports OpenRouter (default), Anthropic direct, or any OpenAI-compatible server (e.g. LM Studio)
// To use Anthropic direct: set LLM_BASE_URL=https://api.anthropic.com/v1 and ANTHROPIC_API_KEY in .env
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
//
// Hybrid (LLM_HYBRID=true): premium endpoint for MANAGER only; OpenRouter for SCREENER + GENERAL.
// Set OPENROUTER_API_KEY (or LLM_BUDGET_API_KEY) + optional LLM_BUDGET_BASE_URL (default openrouter).
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const LLM_HYBRID =
  process.env.LLM_HYBRID === "true" || process.env.LLM_HYBRID === "1";
const BUDGET_BASE_URL =
  process.env.LLM_BUDGET_BASE_URL || "https://openrouter.ai/api/v1";
const BUDGET_API_KEY =
  process.env.LLM_BUDGET_API_KEY || process.env.OPENROUTER_API_KEY || "";
const PREMIUM_API_KEY =
  process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY;

function makeClient(baseURL, apiKey) {
  const isAnthropic = baseURL.includes("anthropic.com");
  return {
    client: new OpenAI({
      baseURL,
      apiKey,
      timeout: 5 * 60 * 1000,
      defaultHeaders: isAnthropic ? { "anthropic-version": "2023-06-01" } : {},
    }),
    isAnthropic,
  };
}

const premium = makeClient(LLM_BASE_URL, PREMIUM_API_KEY);
const budget =
  BUDGET_API_KEY ? makeClient(BUDGET_BASE_URL, BUDGET_API_KEY) : null;

if (LLM_HYBRID && !budget) {
  log(
    "warn",
    "LLM_HYBRID=true but no OPENROUTER_API_KEY (or LLM_BUDGET_API_KEY); SCREENER/GENERAL use premium endpoint"
  );
}

const DEFAULT_MODEL =
  process.env.LLM_MODEL ||
  (premium.isAnthropic ? "claude-haiku-4-5" : "openrouter/healer-alpha");
const BUDGET_FALLBACK = "stepfun/step-3.5-flash:free";
const PREMIUM_FALLBACK = premium.isAnthropic
  ? "claude-haiku-4-5"
  : BUDGET_FALLBACK;

function useBudgetForRole(agentType) {
  return (
    LLM_HYBRID &&
    budget &&
    (agentType === "SCREENER" || agentType === "GENERAL")
  );
}

function pickClientAndFallback(agentType) {
  if (useBudgetForRole(agentType)) {
    return { ...budget, fallbackModel: BUDGET_FALLBACK };
  }
  return { ...premium, fallbackModel: PREMIUM_FALLBACK };
}

/** When caller omits `model`, use the same per-role defaults as index.js (avoids Claude ids on OpenRouter). */
function defaultModelForRole(agentType) {
  if (agentType === "MANAGER") return config.llm.managementModel;
  if (agentType === "SCREENER") return config.llm.screeningModel;
  return config.llm.generalModel;
}

/** Anthropic-style model id on OpenRouter would 404 — remap to budget default (no log; caller logs once). */
function coerceModelForProvider(requestedModel, routing) {
  const m = requestedModel;
  const onOpenRouter = !routing.isAnthropic;
  if (onOpenRouter && m && !m.includes("/") && /^claude/i.test(m)) {
    return process.env.LLM_BUDGET_MODEL || BUDGET_FALLBACK;
  }
  return m;
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null) {
  _agentLoopActive = true;
  try {
    return await runAgentLoopInner(
      goal,
      maxSteps,
      sessionHistory,
      agentType,
      model,
      maxOutputTokens
    );
  } finally {
    _agentLoopActive = false;
  }
}

async function runAgentLoopInner(goal, maxSteps, sessionHistory, agentType, model, maxOutputTokens) {
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,          // inject prior conversation turns
    { role: "user", content: goal },
  ];

  const routing = pickClientAndFallback(agentType);
  const { client, fallbackModel } = routing;
  const rawModel =
    model != null && model !== ""
      ? model
      : defaultModelForRole(agentType) || DEFAULT_MODEL;
  const primaryModel = coerceModelForProvider(rawModel, routing);
  if (primaryModel !== rawModel) {
    log(
      "agent",
      `Budget route: using "${primaryModel}" (model "${rawModel}" is not valid on OpenRouter)`
    );
  }

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      let usedModel = primaryModel;

      // Retry: HTTP/JSON flakes (OpenRouter free tier), empty body, and 502/503/529
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType),
            tool_choice: "auto",
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (err) {
          if (isTransientLlmError(err) && attempt < 2) {
            const wait = (attempt + 1) * 3000;
            log(
              "agent",
              `LLM transport error, retry in ${wait / 1000}s (${(err.message || err).slice(0, 100)})`
            );
            if (attempt === 1 && usedModel !== fallbackModel) {
              usedModel = fallbackModel;
              log("agent", `Switching to fallback model ${fallbackModel}`);
            }
            await sleep(wait);
            continue;
          }
          throw err;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== fallbackModel) {
            usedModel = fallbackModel;
            log("agent", `Switching to fallback model ${fallbackModel}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name;
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
          functionArgs = {};
        }

        const result = await executeTool(functionName, functionArgs);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
