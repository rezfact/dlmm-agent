import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import {
  config,
  LLM_LOCAL_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
} from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";

/** Alternate free model when primary OpenRouter model flakes (502/503/529 retries). */
const OPENROUTER_RETRY_FALLBACK = (
  process.env.LLM_BUDGET_FALLBACK_MODEL || "arcee-ai/trinity-large-preview:free"
).trim();

const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "update_config", "get_position_pnl", "get_my_positions", "set_position_note", "add_pool_note", "get_wallet_balance", "withdraw_liquidity", "add_liquidity", "list_strategies", "get_strategy", "set_active_strategy", "get_pool_detail", "get_token_info", "get_active_bin", "study_top_lpers"]);
// update_config omitted for SCREENER — avoids cron thrash + extra LLM/tool turns during screening
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "add_pool_note", "add_to_blacklist", "get_wallet_balance", "get_my_positions", "list_strategies", "get_strategy", "set_active_strategy", "swap_token", "add_liquidity", "study_top_lpers", "get_pool_detail"]);

/**
 * Smaller tool schema set for Ollama — full SCREENER list + JSON schemas were ~6k+ tokens alone.
 * Pre-loaded screening already embeds holder/narrative/smart-wallet data in the user message.
 */
const LOCAL_SCREENER_TOOL_NAMES = new Set([
  "deploy_position",
  "get_active_bin",
  "get_top_candidates",
  "get_pool_detail",
  "get_wallet_balance",
  "get_my_positions",
  "list_strategies",
  "get_strategy",
  "get_pool_memory",
  "swap_token",
  "add_liquidity",
]);

function getToolsForRole(agentType) {
  let list;
  if (agentType === "MANAGER") list = tools.filter((t) => MANAGER_TOOLS.has(t.function.name));
  else if (agentType === "SCREENER") list = tools.filter((t) => SCREENER_TOOLS.has(t.function.name));
  else list = tools;

  if (config.llm.isLocalEndpoint && agentType === "SCREENER") {
    return list.filter((t) => LOCAL_SCREENER_TOOL_NAMES.has(t.function.name));
  }
  return list;
}

function stringifyToolResultForLlm(result) {
  const raw = typeof result === "string" ? result : JSON.stringify(result);
  const cap = config.llm.toolResultMaxChars ?? 7500;
  if (!config.llm.isLocalEndpoint || raw.length <= cap) return raw;
  return `${raw.slice(0, cap)}…[truncated for local LLM]`;
}

/** True while any agentLoop is executing — crons skip new work to avoid interleaved steps / double screening. */
let _agentLoopActive = false;
export function isAgentLoopRunning() {
  return _agentLoopActive;
}

function isTransientLlmError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return (
    /unexpected end of json|invalid json|econnreset|etimedout|timed out|socket hang up|fetch failed|network|aborted|premature close/.test(
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
  const openRouterCompat = /openrouter\.ai/i.test(baseURL);
  // Ollama / LM Studio on CPU: allow long generations (tunable). OpenRouter: 5m is usually enough.
  const localTimeoutMs =
    parseInt(process.env.LLM_HTTP_TIMEOUT_MS || "", 10) || 32 * 60 * 1000;
  const timeoutMs = isAnthropic
    ? 10 * 60 * 1000
    : openRouterCompat
      ? 5 * 60 * 1000
      : localTimeoutMs;
  return {
    client: new OpenAI({
      baseURL,
      apiKey,
      timeout: timeoutMs,
      defaultHeaders: isAnthropic ? { "anthropic-version": "2023-06-01" } : {},
    }),
    isAnthropic,
    openRouterCompat,
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

// ─── OpenRouter for MANAGER only (local Ollama primary) — until quota / rate limit ─────────
const MERIDIAN_MANAGER_OPENROUTER =
  process.env.MERIDIAN_MANAGER_OPENROUTER === "true" ||
  process.env.MERIDIAN_MANAGER_OPENROUTER === "1";
const MANAGER_OPENROUTER_KEY = (
  process.env.LLM_MANAGER_OPENROUTER_KEY ||
  process.env.OPENROUTER_API_KEY ||
  ""
).trim();

/** After 429/402 on OpenRouter manager, skip cloud until this epoch ms. */
let _managerOpenRouterPausedUntil = 0;

function managerOpenRouterCooldownMs() {
  const h = parseInt(process.env.MERIDIAN_MANAGER_OPENROUTER_COOLDOWN_HOURS || "12", 10);
  return (Number.isFinite(h) && h > 0 ? h : 12) * 3600 * 1000;
}

const managerOpenRouterClient =
  MERIDIAN_MANAGER_OPENROUTER &&
  MANAGER_OPENROUTER_KEY &&
  config.llm.isLocalEndpoint
    ? makeClient(BUDGET_BASE_URL, MANAGER_OPENROUTER_KEY)
    : null;

if (MERIDIAN_MANAGER_OPENROUTER && config.llm.isLocalEndpoint && !MANAGER_OPENROUTER_KEY) {
  log(
    "warn",
    "MERIDIAN_MANAGER_OPENROUTER=1 but OPENROUTER_API_KEY (or LLM_MANAGER_OPENROUTER_KEY) is missing — MANAGER stays on local LLM"
  );
}
if (managerOpenRouterClient) {
  log(
    "startup",
    `MERIDIAN_MANAGER_OPENROUTER: MANAGER → OpenRouter until 429/402, then local for ${parseInt(process.env.MERIDIAN_MANAGER_OPENROUTER_COOLDOWN_HOURS || "12", 10) || 12}h (MERIDIAN_MANAGER_OPENROUTER_COOLDOWN_HOURS)`
  );
}

const DEFAULT_MODEL =
  process.env.LLM_MODEL ||
  (premium.isAnthropic
    ? "claude-haiku-4-5"
    : premium.openRouterCompat
      ? OPENROUTER_DEFAULT_MODEL
      : LLM_LOCAL_DEFAULT_MODEL);
const PREMIUM_FALLBACK = premium.isAnthropic
  ? "claude-haiku-4-5"
  : premium.openRouterCompat
    ? (process.env.LLM_BUDGET_MODEL || OPENROUTER_RETRY_FALLBACK)
    : LLM_LOCAL_DEFAULT_MODEL;

function useBudgetForRole(agentType) {
  return (
    LLM_HYBRID &&
    budget &&
    (agentType === "SCREENER" || agentType === "GENERAL")
  );
}

function pickClientAndFallback(agentType) {
  if (
    agentType === "MANAGER" &&
    managerOpenRouterClient &&
    Date.now() >= _managerOpenRouterPausedUntil
  ) {
    const cloudModel =
      process.env.MERIDIAN_MANAGER_MODEL ||
      process.env.LLM_MANAGER_OPENROUTER_MODEL ||
      OPENROUTER_DEFAULT_MODEL;
    return {
      ...managerOpenRouterClient,
      fallbackModel: process.env.LLM_MODEL || LLM_LOCAL_DEFAULT_MODEL,
      managerOpenRouterModel: cloudModel,
      isManagerOpenRouter: true,
    };
  }
  if (useBudgetForRole(agentType)) {
    return {
      ...budget,
      fallbackModel: budget.isAnthropic
        ? "claude-haiku-4-5"
        : budget.openRouterCompat
          ? (process.env.LLM_BUDGET_MODEL || OPENROUTER_RETRY_FALLBACK)
          : LLM_LOCAL_DEFAULT_MODEL,
    };
  }
  return { ...premium, fallbackModel: PREMIUM_FALLBACK };
}

/** When caller omits `model`, use the same per-role defaults as index.js (avoids Claude ids on OpenRouter). */
function defaultModelForRole(agentType) {
  if (agentType === "MANAGER") return config.llm.managementModel;
  if (agentType === "SCREENER") return config.llm.screeningModel;
  return config.llm.generalModel;
}

/** Claude-style ids only work on Anthropic/OpenRouter — remap so local endpoints do not 404. */
function coerceModelForProvider(requestedModel, routing) {
  const m = requestedModel;
  if (routing.isAnthropic) return m;
  if (m && !m.includes("/") && /^claude/i.test(m)) {
    if (routing.openRouterCompat) {
      return process.env.LLM_BUDGET_MODEL || OPENROUTER_DEFAULT_MODEL;
    }
    return process.env.LLM_MODEL || LLM_LOCAL_DEFAULT_MODEL;
  }
  return m;
}

const TOOL_REQUIRED_INTENTS = /\b(deploy|open position|open|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|self.?update|pull latest|git pull|update yourself|config|setting|threshold|set |change|update |balance|wallet|position|portfolio|pnl|yield|range|screen|candidate|find pool|search|research|token|smart wallet|whale|watch.?list|tracked wallet|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|lesson|learned|teach|pin|unpin)\b/i;

function shouldRequireRealToolUse(goal, agentType, requireTool) {
  if (requireTool) return true;
  if (agentType === "MANAGER") return false;
  return TOOL_REQUIRED_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /tool_choice/i.test(message) && /required/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {{ content: string, userMessage: string, deploySucceeded?: boolean }}
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

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, requireTool);
  let sawToolCall = false;
  let noToolRetryCount = 0;

  /** True only after deploy_position returns a real or DRY_RUN simulated deploy (for screening report guards). */
  let deploySucceededThisRun = false;

  let emptyStreak = 0;
  const EMPTY_LOG_EVERY = 6;
  const EMPTY_FAIL_AFTER = 24;
  stepLoop: for (let step = 0; step < maxSteps; step++) {
    // After empty LLM replies we step-- and continue; `step` stays the same, so without this
    // we'd spam "Step 1/32" on every retry.
    if (emptyStreak === 0) {
      log("agent", `Step ${step + 1}/${maxSteps}`);
    }

    try {
      const routingThisStep = pickClientAndFallback(agentType);
      const clientThisStep = routingThisStep.client;
      const fallbackModel = routingThisStep.fallbackModel;
      const rawModel =
        routingThisStep.managerOpenRouterModel ??
        (model != null && model !== ""
          ? model
          : defaultModelForRole(agentType) || DEFAULT_MODEL);
      const primaryModel = coerceModelForProvider(rawModel, routingThisStep);
      if (primaryModel !== rawModel && emptyStreak === 0) {
        log(
          "agent",
          `Using "${primaryModel}" (remapped from "${rawModel}" for this LLM endpoint)`
        );
      }

      let usedModel = primaryModel;

      // Retry: HTTP/JSON flakes (OpenRouter free tier), empty body, and 502/503/529
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await clientThisStep.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType),
            tool_choice: "auto",
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (err) {
          if (
            routingThisStep.isManagerOpenRouter &&
            (err?.status === 429 || err?.status === 402)
          ) {
            _managerOpenRouterPausedUntil = Date.now() + managerOpenRouterCooldownMs();
            log(
              "agent",
              `Manager OpenRouter paused (${err.status}) — local LLM until ${new Date(_managerOpenRouterPausedUntil).toISOString()}`
            );
            step--;
            continue stepLoop;
          }
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
      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes / free OpenRouter models often return null content — do not burn maxSteps on retries
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          emptyStreak++;
          if (emptyStreak > EMPTY_FAIL_AFTER) {
            throw new Error(
              "Too many empty LLM responses in a row — provider/model issue. Use a paid OpenRouter model or try again later."
            );
          }
          // Avoid log flooding on flaky free models (same step retried many times)
          if (
            emptyStreak <= 2 ||
            emptyStreak % EMPTY_LOG_EVERY === 0 ||
            emptyStreak >= EMPTY_FAIL_AFTER - 2
          ) {
            log(
              "agent",
              `Empty LLM response (${emptyStreak}/${EMPTY_FAIL_AFTER}), retrying step ${step + 1}/${maxSteps}...`
            );
          }
          step--;
          continue;
        }
        emptyStreak = 0;
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return {
          content: msg.content,
          userMessage: goal,
          deploySucceeded: deploySucceededThisRun,
        };
      }
      sawToolCall = true;

      emptyStreak = 0;
      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });
        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        if (functionName === "deploy_position" && result && !result.blocked) {
          if (process.env.DRY_RUN === "true" && result.dry_run) {
            deploySucceededThisRun = true;
          } else if (
            result.success === true &&
            result.position &&
            Array.isArray(result.txs) &&
            result.txs.length > 0
          ) {
            deploySucceededThisRun = true;
          }
        }

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: stringifyToolResultForLlm(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry (don't consume a step)
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        step--;
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return {
    content: "Max steps reached. Review logs for partial progress.",
    userMessage: goal,
    deploySucceeded: deploySucceededThisRun,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
