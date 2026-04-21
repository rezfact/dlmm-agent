import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dataPath } from "./data-path.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = dataPath("user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl) process.env.RPC_URL ||= u.rpcUrl;
if (u.walletKey) {
  console.warn(
    "[config] WARNING: walletKey found in user-config.json. " +
    "Store your private key in .env as WALLET_PRIVATE_KEY instead. " +
    "Keeping secrets in user-config.json risks exposure if the file is synced or shared."
  );
  process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
}
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
// Optional OpenRouter-style overrides from user-config (colleague-style presets). Prefer .env for secrets.
if (u.llmBaseUrl && String(u.llmBaseUrl).trim()) {
  process.env.LLM_BASE_URL ||= String(u.llmBaseUrl).trim();
}
const _llmKeyFromFile = u.llmApiKey != null ? String(u.llmApiKey).trim() : "";
if (
  _llmKeyFromFile &&
  !(process.env.OPENROUTER_API_KEY || "").trim() &&
  !(process.env.LLM_API_KEY || "").trim()
) {
  console.warn(
    "[config] WARNING: llmApiKey in user-config.json applied to OPENROUTER_API_KEY. " +
      "Prefer OPENROUTER_API_KEY or LLM_API_KEY in .env — avoid committing keys."
  );
  process.env.OPENROUTER_API_KEY ||= _llmKeyFromFile;
}

const LLM_HYBRID =
  process.env.LLM_HYBRID === "true" || process.env.LLM_HYBRID === "1";

/** When LLM_BASE_URL is not OpenRouter (e.g. Ollama/LM Studio), use small local defaults unless overridden. */
const LLM_BASE_URL_RAW = process.env.LLM_BASE_URL || "";
const USE_OPENROUTER_DEFAULT =
  !LLM_BASE_URL_RAW || /openrouter\.ai/i.test(LLM_BASE_URL_RAW);
const LOCAL_DEFAULT_MODEL =
  process.env.LLM_LOCAL_MODEL || "qwen2.5:3b";
/** Default tag for Ollama (`ollama pull qwen2.5:3b`). Override with LLM_LOCAL_MODEL. */
export const LLM_LOCAL_DEFAULT_MODEL = LOCAL_DEFAULT_MODEL;

/**
 * Default OpenRouter model id when the primary API is OpenRouter (`LLM_BASE_URL` unset or openrouter.ai),
 * and for **MANAGER-only** OpenRouter when `MERIDIAN_MANAGER_OPENROUTER=1` with Ollama as `LLM_BASE_URL`
 * (SCREENER/GENERAL stay on Ollama — see `docs/llm-ollama-openrouter-manager-notes.md`).
 * Override: `OPENROUTER_DEFAULT_MODEL`, `LLM_OPENROUTER_MODEL`, `MERIDIAN_MANAGER_MODEL`, or user-config role keys.
 */
export const OPENROUTER_DEFAULT_MODEL = (
  process.env.OPENROUTER_DEFAULT_MODEL ||
  process.env.LLM_OPENROUTER_MODEL ||
  "nvidia/nemotron-3-super-120b-a12b:free"
).trim();

/**
 * True when LLM_BASE_URL is not OpenRouter (Ollama, LM Studio, vLLM, etc.).
 * Enables lower maxSteps / screeningMaxSteps / token caps so small local models finish in reasonable time.
 * Override any cap via user-config.json (maxSteps, screeningMaxSteps, maxTokens) or env LLM_LOCAL_* below.
 */
export const LLM_IS_LOCAL_ENDPOINT = !USE_OPENROUTER_DEFAULT;

/**
 * Small VPS preset (~4 cores / 8 GiB RAM + Ollama on CPU): tighter LLM caps and slimmer preloads
 * so screening/management finish inside Ollama’s default ctx without 20+ minute hangs.
 * Set MERIDIAN_VPS_PROFILE=small (or MERIDIAN_VPS_SMALL=1) alongside LLM_BASE_URL=…Ollama….
 */
const VPS_SMALL =
  process.env.MERIDIAN_VPS_PROFILE === "small" ||
  process.env.MERIDIAN_VPS_PROFILE === "4c8g" ||
  process.env.MERIDIAN_VPS_SMALL === "1" ||
  process.env.MERIDIAN_VPS_SMALL === "true";

/** MERIDIAN_CAVEMAN / LLM_TERSE / user-config terseCaveman — only applies to local endpoints (Ollama, LM Studio). */
function envTriState(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return null;
}

/**
 * Short, low-filler replies for small local models (token + CPU savings).
 * Inspired by github.com/JuliusBrussee/caveman — implemented here in prompts, not in Ollama.
 * Default ON for local; disable with MERIDIAN_CAVEMAN=0 or terseCaveman: false in user-config.json.
 */
function computeTerseCaveman() {
  if (!LLM_IS_LOCAL_ENDPOINT) return false;
  const a = envTriState("MERIDIAN_CAVEMAN");
  if (a !== null) return a;
  const b = envTriState("LLM_TERSE");
  if (b !== null) return b;
  if (u.terseCaveman === true || u.terseCaveman === "true") return true;
  if (u.terseCaveman === false || u.terseCaveman === "false") return false;
  return true;
}

const LOCAL_MAX_STEPS =
  parseInt(process.env.LLM_LOCAL_MAX_STEPS || "", 10) ||
  (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT ? 8 : 10);
const LOCAL_SCREENING_MAX_STEPS =
  parseInt(process.env.LLM_LOCAL_SCREENING_MAX_STEPS || "", 10) ||
  (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT ? 8 : 12);
const LOCAL_MAX_TOKENS =
  parseInt(process.env.LLM_LOCAL_MAX_TOKENS || "", 10) ||
  (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT ? 1024 : 1536);
/** Pools pre-fetched + enriched for screening prompt (fewer = less context for weak models). */
const SCREENING_CANDIDATE_LIMIT =
  parseInt(process.env.LLM_SCREENING_CANDIDATE_LIMIT || "", 10) ||
  (LLM_IS_LOCAL_ENDPOINT ? 2 : 5);

const SCREENING_NARRATIVE_MAX =
  parseInt(process.env.MERIDIAN_SCREENING_NARRATIVE_MAX || "", 10) ||
  (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT ? 100 : LLM_IS_LOCAL_ENDPOINT ? 180 : 500);

const SCREENING_HOLDERS_LIMIT =
  parseInt(process.env.MERIDIAN_SCREENING_HOLDERS_LIMIT || "", 10) ||
  (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT ? 35 : 100);

/** Max JSON chars per tool result sent to local LLM (full payload on cloud). */
const LOCAL_TOOL_RESULT_MAX =
  parseInt(process.env.MERIDIAN_TOOL_RESULT_MAX || "", 10) ||
  (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT ? 4000 : LLM_IS_LOCAL_ENDPOINT ? 7500 : 10_000_000);

const LLM_BUDGET_MODEL_DEFAULT =
  process.env.LLM_BUDGET_MODEL
  ?? (USE_OPENROUTER_DEFAULT ? OPENROUTER_DEFAULT_MODEL : LOCAL_DEFAULT_MODEL);

/** Integer clamp for VPS caps and sane bounds. */
function clampInt(n, lo, hi) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/** Resolve LLM fields; when MERIDIAN_VPS_PROFILE=small + Ollama, clamp user-config so old presets cannot starve CPU/RAM. */
function resolveLlmForConfig() {
  const vpsCapWarnings = [];
  const uMax = u.maxSteps != null ? Number(u.maxSteps) : NaN;
  const uScr = u.screeningMaxSteps != null ? Number(u.screeningMaxSteps) : NaN;
  const uTok = u.maxTokens != null ? Number(u.maxTokens) : NaN;

  let maxSteps = Number.isFinite(uMax)
    ? Math.floor(uMax)
    : LLM_IS_LOCAL_ENDPOINT
      ? LOCAL_MAX_STEPS
      : 20;
  if (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT) {
    const prev = maxSteps;
    maxSteps = clampInt(maxSteps, 4, 10);
    if (prev !== maxSteps) vpsCapWarnings.push(`maxSteps ${prev}→${maxSteps} (VPS small cap)`);
  }

  let screeningMaxSteps;
  if (!LLM_IS_LOCAL_ENDPOINT) {
    screeningMaxSteps = Number.isFinite(uScr) && u.screeningMaxSteps != null
      ? Math.floor(uScr)
      : Math.max(Number.isFinite(uMax) ? Math.floor(uMax) : 20, 32);
  } else {
    const fallback = Math.max(maxSteps, LOCAL_SCREENING_MAX_STEPS);
    screeningMaxSteps = Number.isFinite(uScr) && u.screeningMaxSteps != null
      ? Math.floor(uScr)
      : fallback;
    if (VPS_SMALL) {
      const prev = screeningMaxSteps;
      screeningMaxSteps = clampInt(screeningMaxSteps, 4, 10);
      if (prev !== screeningMaxSteps) {
        vpsCapWarnings.push(`screeningMaxSteps ${prev}→${screeningMaxSteps} (VPS small cap)`);
      }
    }
  }

  let maxTokens = Number.isFinite(uTok)
    ? Math.floor(uTok)
    : LLM_IS_LOCAL_ENDPOINT
      ? LOCAL_MAX_TOKENS
      : 4096;
  if (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT) {
    const prev = maxTokens;
    maxTokens = clampInt(maxTokens, 256, 1280);
    if (prev !== maxTokens) vpsCapWarnings.push(`maxTokens ${prev}→${maxTokens} (VPS small cap)`);
  }

  let screeningCandidateLimit = u.screeningCandidateLimit ?? SCREENING_CANDIDATE_LIMIT;
  if (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT) {
    const prev = Math.floor(Number(screeningCandidateLimit)) || SCREENING_CANDIDATE_LIMIT;
    screeningCandidateLimit = clampInt(prev, 1, 3);
    if (prev !== screeningCandidateLimit) {
      vpsCapWarnings.push(`screeningCandidateLimit ${prev}→${screeningCandidateLimit} (VPS small cap)`);
    }
  }

  let screeningNarrativeMaxChars = u.screeningNarrativeMaxChars ?? SCREENING_NARRATIVE_MAX;
  if (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT) {
    const prev = Math.floor(Number(screeningNarrativeMaxChars)) || SCREENING_NARRATIVE_MAX;
    screeningNarrativeMaxChars = clampInt(prev, 40, 300);
    if (prev !== screeningNarrativeMaxChars) {
      vpsCapWarnings.push(`screeningNarrativeMaxChars ${prev}→${screeningNarrativeMaxChars} (VPS small cap)`);
    }
  }

  let screeningHoldersLimit = u.screeningHoldersLimit ?? SCREENING_HOLDERS_LIMIT;
  if (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT) {
    const prev = Math.floor(Number(screeningHoldersLimit)) || SCREENING_HOLDERS_LIMIT;
    screeningHoldersLimit = clampInt(prev, 15, 55);
    if (prev !== screeningHoldersLimit) {
      vpsCapWarnings.push(`screeningHoldersLimit ${prev}→${screeningHoldersLimit} (VPS small cap)`);
    }
  }

  let toolResultMaxChars = u.toolResultMaxChars ?? LOCAL_TOOL_RESULT_MAX;
  if (VPS_SMALL && LLM_IS_LOCAL_ENDPOINT) {
    const prev = Math.floor(Number(toolResultMaxChars)) || LOCAL_TOOL_RESULT_MAX;
    toolResultMaxChars = clampInt(prev, 2000, 5000);
    if (prev !== toolResultMaxChars) {
      vpsCapWarnings.push(`toolResultMaxChars ${prev}→${toolResultMaxChars} (VPS small cap)`);
    }
  }

  return {
    maxSteps,
    screeningMaxSteps,
    maxTokens,
    screeningCandidateLimit,
    screeningNarrativeMaxChars,
    screeningHoldersLimit,
    toolResultMaxChars,
    vpsCapWarnings,
  };
}

const _llmResolved = resolveLlmForConfig();

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    // Legacy key from older evolveThresholds writes — prefer minFeeActiveTvlRatio
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? u.minFeeTvlRatio ?? 0.05,
    /** Soft cap on pool volatility (0–5+ typical); used by getTopCandidates + evolveThresholds */
    maxVolatility: u.maxVolatility ?? 10,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    /** If non-empty, only these launchpads pass screening (optional stricter mode). */
    allowedLaunchpads: u.allowedLaunchpads ?? [],
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    /** Base token symbols or pair name stems (before "-SOL") to hard-skip, e.g. ["TOKABU","UNC"] */
    blockedSymbols:     Array.isArray(u.blockedSymbols) ? u.blockedSymbols.map(String) : [],
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    /** setup.js writes `stopLossPct`; management prompt may use emergencyPriceDropPct. */
    emergencyPriceDropPct: u.emergencyPriceDropPct ?? u.stopLossPct ?? -50,
    /** Alias for upstream management rules (same numeric floor as emergencyPriceDropPct). */
    stopLossPct: u.stopLossPct ?? u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:  u.strategy  ?? "bid_ask",
    binsBelow: u.binsBelow ?? 69,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens: _llmResolved.maxTokens,
    maxSteps: _llmResolved.maxSteps,
    /**
     * Cloud: high ceiling for flaky free APIs + long tool chains.
     * Local (Ollama): keep low — each step can take minutes on CPU.
     * With MERIDIAN_VPS_PROFILE=small, user-config highs are clamped (see vpsCapWarnings).
     */
    screeningMaxSteps: _llmResolved.screeningMaxSteps,
    /** Pre-loaded pools in screening cycle (index.js). */
    screeningCandidateLimit: _llmResolved.screeningCandidateLimit,
    /** Max chars of token narrative embedded per pool in screening preload (index.js). */
    screeningNarrativeMaxChars: _llmResolved.screeningNarrativeMaxChars,
    /** getTokenHolders limit during screening preload (index.js). */
    screeningHoldersLimit: _llmResolved.screeningHoldersLimit,
    /** Truncate tool JSON returned to the model (agent.js); cloud uses a very high ceiling. */
    toolResultMaxChars: _llmResolved.toolResultMaxChars,
    /** Non-empty if MERIDIAN_VPS_PROFILE=small clamped user-config.json (logged at startup). */
    vpsCapWarnings: _llmResolved.vpsCapWarnings,
    /** True when MERIDIAN_VPS_PROFILE=small (or MERIDIAN_VPS_SMALL=1) — see startup log. */
    vpsLowResource: !!(VPS_SMALL && LLM_IS_LOCAL_ENDPOINT),
    /** Set when using Ollama/LM Studio — index.js shortens narrative preloads. */
    isLocalEndpoint: LLM_IS_LOCAL_ENDPOINT,
    /** Prompt suffix: minimal filler, short final replies (local LLM only). */
    terseCaveman: computeTerseCaveman(),
    // Hybrid: premium (Anthropic / primary LLM_BASE_URL) for manager; budget endpoint for screener + chat
    managementModel:
      u.managementModel
      ?? process.env.LLM_MODEL
      ?? (USE_OPENROUTER_DEFAULT ? OPENROUTER_DEFAULT_MODEL : LOCAL_DEFAULT_MODEL),
    screeningModel:
      u.screeningModel
      ?? (LLM_HYBRID ? LLM_BUDGET_MODEL_DEFAULT : process.env.LLM_MODEL)
      ?? (USE_OPENROUTER_DEFAULT ? OPENROUTER_DEFAULT_MODEL : LOCAL_DEFAULT_MODEL),
    generalModel:
      u.generalModel
      ?? (LLM_HYBRID ? LLM_BUDGET_MODEL_DEFAULT : process.env.LLM_MODEL)
      ?? (USE_OPENROUTER_DEFAULT ? OPENROUTER_DEFAULT_MODEL : LOCAL_DEFAULT_MODEL),
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/** Runtime terse mode (after update_config, value may be string). */
export function isTerseCavemanLive() {
  if (!config.llm.isLocalEndpoint) return false;
  const t = config.llm.terseCaveman;
  if (t === false || t === "false" || t === 0 || t === "0") return false;
  if (t === true || t === "true" || t === 1 || t === "1") return true;
  return true;
}

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    else if (fresh.minFeeTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeTvlRatio;
    if (fresh.maxVolatility != null) s.maxVolatility = fresh.maxVolatility;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         != null) s.maxTvl         = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (Array.isArray(fresh.blockedSymbols)) s.blockedSymbols = fresh.blockedSymbols.map(String);
  } catch { /* ignore */ }
}
