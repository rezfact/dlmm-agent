# LLM notes: Ollama for SCREENER + GENERAL, OpenRouter for MANAGER only

This matches the recommended VPS layout: **cheap / unlimited-ish local inference** for screening and chat, **OpenRouter only for management cycles** (heavier reasoning, tool chains).

## Target `.env` (summary)

| Variable | Purpose |
|----------|---------|
| `LLM_BASE_URL` | **Must** point at Ollama (or LM Studio), e.g. `http://127.0.0.1:11434/v1` or `http://host.docker.internal:11434/v1` in Docker. |
| `LLM_API_KEY` | Whatever your local server expects (often `ollama`). |
| `LLM_MODEL` / `LLM_LOCAL_MODEL` | Tag from `ollama list` (e.g. `qwen2.5:3b`). Used for **SCREENER**, **GENERAL** / Telegram chat, and **MANAGER** when OpenRouter is off or cooling down. |
| `MERIDIAN_MANAGER_OPENROUTER` | `1` or `true` → **MANAGEMENT** `agentLoop` calls OpenRouter; screening + general stay on `LLM_BASE_URL`. |
| `OPENROUTER_API_KEY` | Required for that MANAGER path (or `LLM_MANAGER_OPENROUTER_KEY` for a separate key). |
| `MERIDIAN_MANAGER_MODEL` | Optional. If unset, defaults to `OPENROUTER_DEFAULT_MODEL` (see `config.js`, currently a free OpenRouter id). |
| `MERIDIAN_MANAGER_OPENROUTER_COOLDOWN_HOURS` | After HTTP **429** or **402** on OpenRouter MANAGER calls, Meridian forces MANAGER onto **local** Ollama for this many hours (default **12**), then tries OpenRouter again automatically. |

Do **not** set `LLM_HYBRID=true` for this layout unless you intend Anthropic + OpenRouter hybrid (different routing).

## Who talks to which API

- **SCREENER** cron → `LLM_BASE_URL` (Ollama) + `screeningModel` / local defaults.
- **MANAGER** cron → OpenRouter **if** `MERIDIAN_MANAGER_OPENROUTER=1` and not in cooldown; else Ollama.
- **GENERAL** (REPL / Telegram LLM replies) → `LLM_BASE_URL` (Ollama).

Implementation: `agent.js` → `pickClientAndFallback(agentType)`; only `agentType === "MANAGER"` uses `managerOpenRouterClient` when enabled.

## Daily / free-tier limit hit (429, 402, or “quota exceeded”)

### A) Automatic cooldown (no file edit on VPS)

On **429** or **402**, Meridian logs something like `Manager OpenRouter paused … — local LLM until <ISO timestamp>` and sets an internal timer for `MERIDIAN_MANAGER_OPENROUTER_COOLDOWN_HOURS` (default 12h). Until then, **MANAGER** uses the same Ollama model as the rest. **No restart required.**

When the deadline passes, the **next** MANAGER step uses OpenRouter again without changing `.env`.

### B) Manual “turn OpenRouter MANAGER off until tomorrow”

1. On the VPS, edit `.env`: `MERIDIAN_MANAGER_OPENROUTER=0` (or remove / comment the line).
2. Restart the process, e.g. `docker compose restart meridian` (or your `pm2` / systemd unit).

SCREENER / chat keep using Ollama the whole time.

### C) Next day — use OpenRouter for MANAGER again

1. Set `MERIDIAN_MANAGER_OPENROUTER=1` again (if you turned it off manually).
2. Restart Meridian **or** wait if you only relied on the automatic cooldown and the window already expired.
3. **Free tiers** often reset on a **calendar UTC day** or a **rolling 24h** window — OpenRouter’s dashboard / error body is authoritative. If you still get 429 after “midnight”, wait a bit longer or switch `MERIDIAN_MANAGER_MODEL` to another free model in `.env`.

## Optional: shorter or longer cooldown

- `MERIDIAN_MANAGER_OPENROUTER_COOLDOWN_HOURS=24` → stay on Ollama MANAGER for a day after a rate limit.
- `MERIDIAN_MANAGER_OPENROUTER_COOLDOWN_HOURS=1` → retry OpenRouter sooner (more 429 noise).

## Sanity checks after any switch

- Logs at startup: local caps line when `LLM_BASE_URL` is not OpenRouter; optional `MERIDIAN_MANAGER_OPENROUTER: MANAGER → OpenRouter…` when hybrid is on.
- If `LLM_BASE_URL` is **unset**, Meridian defaults to **OpenRouter for everything** — not this layout. Always set `LLM_BASE_URL` explicitly for Ollama-first prod.
