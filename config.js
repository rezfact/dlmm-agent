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
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

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
 * True when LLM_BASE_URL is not OpenRouter (Ollama, LM Studio, vLLM, etc.).
 * Enables lower maxSteps / screeningMaxSteps / token caps so small local models finish in reasonable time.
 * Override any cap via user-config.json (maxSteps, screeningMaxSteps, maxTokens) or env LLM_LOCAL_* below.
 */
export const LLM_IS_LOCAL_ENDPOINT = !USE_OPENROUTER_DEFAULT;

const LOCAL_MAX_STEPS =
  parseInt(process.env.LLM_LOCAL_MAX_STEPS || "", 10) || 10;
const LOCAL_SCREENING_MAX_STEPS =
  parseInt(process.env.LLM_LOCAL_SCREENING_MAX_STEPS || "", 10) || 12;
const LOCAL_MAX_TOKENS =
  parseInt(process.env.LLM_LOCAL_MAX_TOKENS || "", 10) || 1536;
/** Pools pre-fetched + enriched for screening prompt (fewer = less context for weak models). */
const SCREENING_CANDIDATE_LIMIT =
  parseInt(process.env.LLM_SCREENING_CANDIDATE_LIMIT || "", 10) ||
  (LLM_IS_LOCAL_ENDPOINT ? 2 : 5);

const LLM_BUDGET_MODEL_DEFAULT =
  process.env.LLM_BUDGET_MODEL
  ?? (USE_OPENROUTER_DEFAULT
    ? "arcee-ai/trinity-large-preview:free"
    : LOCAL_DEFAULT_MODEL);

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
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
    maxBundlersPct:    u.maxBundlersPct    ?? 30,  // max bot/bundler holders % (from Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads: u.blockedLaunchpads ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    emergencyPriceDropPct: u.emergencyPriceDropPct ?? -50,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
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
    maxTokens:
      u.maxTokens
      ?? (LLM_IS_LOCAL_ENDPOINT ? LOCAL_MAX_TOKENS : 4096),
    maxSteps:
      u.maxSteps
      ?? (LLM_IS_LOCAL_ENDPOINT ? LOCAL_MAX_STEPS : 20),
    /**
     * Cloud: high ceiling for flaky free APIs + long tool chains.
     * Local (Ollama): keep low — each step can take minutes on CPU.
     */
    screeningMaxSteps:
      u.screeningMaxSteps
      ?? (LLM_IS_LOCAL_ENDPOINT
        ? Math.max(u.maxSteps ?? LOCAL_MAX_STEPS, LOCAL_SCREENING_MAX_STEPS)
        : Math.max(u.maxSteps ?? 20, 32)),
    /** Pre-loaded pools in screening cycle (index.js). */
    screeningCandidateLimit: u.screeningCandidateLimit ?? SCREENING_CANDIDATE_LIMIT,
    /** Set when using Ollama/LM Studio — index.js shortens narrative preloads. */
    isLocalEndpoint: LLM_IS_LOCAL_ENDPOINT,
    // Hybrid: premium (Anthropic / primary LLM_BASE_URL) for manager; budget endpoint for screener + chat
    managementModel:
      u.managementModel
      ?? process.env.LLM_MODEL
      ?? (USE_OPENROUTER_DEFAULT ? "openrouter/healer-alpha" : LOCAL_DEFAULT_MODEL),
    screeningModel:
      u.screeningModel
      ?? (LLM_HYBRID ? LLM_BUDGET_MODEL_DEFAULT : process.env.LLM_MODEL)
      ?? (USE_OPENROUTER_DEFAULT ? "openrouter/hunter-alpha" : LOCAL_DEFAULT_MODEL),
    generalModel:
      u.generalModel
      ?? (LLM_HYBRID ? LLM_BUDGET_MODEL_DEFAULT : process.env.LLM_MODEL)
      ?? (USE_OPENROUTER_DEFAULT ? "openrouter/healer-alpha" : LOCAL_DEFAULT_MODEL),
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

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
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         != null) s.maxTvl         = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe      != null) s.timeframe      = fresh.timeframe;
    if (fresh.category       != null) s.category       = fresh.category;
  } catch { /* ignore */ }
}

