# Meeting Intelligence Agent — Session 5

A Chrome extension that prepares you for upcoming meetings by autonomously gathering context — calendar, email, attendee profiles, company info — and synthesizing it into an actionable brief. Built on Google Gemini 2.5 Flash with a custom multi-step agent loop. Tools live in a local MCP server that hits real APIs (Google Calendar, Gmail, SerpAPI, Gemini for synthesis).

> **Session 5 upgrades:**
> 1. **Structured-reasoning prompt** — the system prompt now satisfies all nine criteria of the **Prompt Evaluation Assistant** rubric: explicit step-by-step reasoning with named reasoning-type tags (`[PLAN]`, `[LOOKUP]`, `[COMPUTE]`, `[VERIFY]`, `[SYNTHESIS]`), strict reasoning↔tool separation, a 5-item self-check checklist, explicit fallback rules, and a fully worked example. The UI ([popup.js](popup.js) `splitTaggedBlocks()`) renders each tagged block as its own colored, collapsible row so the chain-of-thought is visibly structured at runtime. Full evaluator scoring (before / after) and per-criterion mapping live in **[docs/prompt-evaluation.md](docs/prompt-evaluation.md)**.
> 2. **MCP server rewritten in Python** — the local MCP server in [`mcp-server/`](mcp-server/) was rewritten from Node.js to **Python 3.12 + Pydantic v2 + the official MCP Python SDK**, managed with **[uv](https://docs.astral.sh/uv/)**. Every tool input and output is a Pydantic model; the JSON Schema the agent sees over `tools/list` is generated directly from the type-annotated function signatures. The HTTP contract over `/mcp` is unchanged — the Chrome extension does not need to change.
>
> 📺 **Demo video:** _YouTube link to be added here once recorded._

## Prompt qualification (Session 5)

| Evaluator criterion | Session 4 | Session 5 |
|---|:---:|:---:|
| Explicit reasoning instructions | ❌ | ✅ |
| Structured output format | ✅ | ✅ |
| Separation of reasoning and tools | ❌ | ✅ |
| Conversation loop support | ✅ | ✅ |
| Instructional framing (examples) | ✅ | ✅ |
| Internal self-checks | ❌ | ✅ |
| Reasoning-type awareness | ❌ | ✅ |
| Error handling / fallbacks | ✅ | ✅ |
| **Total true** | **4 / 8** | **8 / 8** |

The full evaluator JSON output for both prompts, plus a per-criterion mapping to specific sections of the new `SYSTEM_PROMPT`, is in **[docs/prompt-evaluation.md](docs/prompt-evaluation.md)**.

## What it does

Ask it questions like:

- *Prepare me for my next meeting*
- *Show me all meetings today and research the attendees*
- *What's my meeting load this week?*

It plans, calls 3–7 tools (calendar, email, web/LinkedIn, attendee profiles, stats), and returns a structured markdown brief with attendee cards, talking points, and a prep checklist. Every step is preceded by a tagged reasoning block (`[PLAN]` / `[LOOKUP]` / `[COMPUTE]`) and audited by a `[VERIFY]` block after the tool results return — visible in the reasoning chain in the popup.

## Architecture

```
┌─────────────────────────────────────────────┐    ┌─ External services ────────────────┐
│ Chrome Extension (MV3)                      │    │                                    │
│                                             │    │  Gemini API (agent loop)           │
│  popup.html / popup.js / styles.css ← UI    │    │  Gemini API (server-side reasoning)│
│         │                                   │    │  Google Calendar API               │
│  agent.js ← manual agent loop               │    │  Gmail API                         │
│         │                                   │    │  SerpAPI (Google SERP)             │
│  api.js  ───── fetch ────────────────────────────→  generativelanguage.googleapis.com │
│         │                                   │    │                                    │
│  tools.js (MCP shim)                        │    └────▲───▲───▲───────────────────────┘
│  mcp-client.js (JSON-RPC over HTTP+SSE)     │         │   │   │
│         │                                   │         │   │   │
└─────────┼───────────────────────────────────┘         │   │   │
          │                                             │   │   │
          │ HTTP/SSE :3737                              │   │   │
          │                                             │   │   │
┌─────────▼───────────────────────────────────┐         │   │   │
│ Local MCP Server (Python 3.12 + Pydantic v2)│         │   │   │
│ Managed by uv                                │         │   │   │
│                                             │         │   │   │
│  server.py  FastMCP + streamable_http_app   │         │   │   │
│  tools.py   5 async tool implementations    │ ────────┘   │   │
│  models.py  Pydantic v2 I/O models          │             │   │
│   ├ getUpcomingMeetings  ──→ Calendar      ─┼─────────────┘   │
│   ├ searchGmail          ──→ Gmail         ─┼─────────────────┘
│   ├ searchWebInfo        ──→ Gemini→SerpAPI │
│   ├ analyzeAttendeeBackground ─→ SerpAPI+Gemini
│   └ calculateMeetingStats ─→ pure compute   │
│                                             │
│  google_auth.py  OAuth + token persistence  │
│  serpapi.py / llm.py / cache.py             │
│                                             │
│  ~/.meeting-intel-mcp/google-tokens.json    │
│  mcp-server/.env (API keys, config)         │
└─────────────────────────────────────────────┘
```

The extension itself is small — the agent loop, the UI, and a thin MCP-client shim. All five tools live in the MCP server, which holds the API keys, OAuth refresh tokens, and any caching. Either side can be swapped: a different LLM provider replaces `api.js`, a different MCP host (Claude Desktop, Cursor, etc.) replaces the extension entirely.

### Agent flow

```
┌──────────────────────────────────────────┐
│         CHROME EXTENSION                 │
│  ┌────────────────────────────────────┐ │
│  │  popup.js  (UI)                    │ │
│  └──────────────┬─────────────────────┘ │
│                 │                        │
│  ┌──────────────▼─────────────────────┐ │
│  │  Agent loop (agent.js)             │ │
│  │  - conversation history            │ │
│  │  - 10-iteration cap                │ │
│  │  - retry once on tool error        │ │
│  └──────────────┬─────────────────────┘ │
│                 │                        │
│  ┌──────────────▼─────────────────────┐ │     ┌─────────────────────┐
│  │  api.js → Gemini 2.5 Flash         │ ───→ │  Decides tool calls │
│  └──────────────┬─────────────────────┘     │  Writes final brief │
│                 │                            └─────────────────────┘
│  ┌──────────────▼─────────────────────┐
│  │  tools.js (MCP shim)               │
│  │  mcp-client.js                     │
│  └──────────────┬─────────────────────┘
└─────────────────┼────────────────────────
                  │ POST /mcp (JSON-RPC)
                  ▼
        ┌─────────────────────┐
        │  MCP server         │ ──→ Real APIs (Calendar / Gmail / SerpAPI / Gemini)
        │  (5 tools)          │
        └─────────────────────┘
```

### Multi-step reasoning flow

Worked example for *"Prepare me for my next meeting"* — typically 3 LLM turns with a batch of parallel tool calls in the middle.

```
Turn 1 → tool_use: getUpcomingMeetings({hoursAhead: 24})
         server fetches from Google Calendar (OAuth)

Turn 2 → tool_use blocks (parallel):
           analyzeAttendeeBackground("john@acme.com")
           analyzeAttendeeBackground("jane@acme.com")
           searchWebInfo("Acme Corp", type: "company")
           searchGmail("Acme")
         server runs:
           attendee #1: SerpAPI + Gemini synthesis
           attendee #2: SerpAPI + Gemini synthesis
           web info:    Gemini-first, SerpAPI fallback (no freshness keyword)
           gmail:       Gmail API search
         all 4 results returned as one user turn

Turn 3 → end_turn: final markdown brief
         (popup.js renders attendees, talking points, prep checklist)
```

### Key architecture points

1. **Conversation history is stateless** — every Gemini call includes the full prior history + tool results.
2. **Parallel tool calls** — a single LLM turn can request multiple tools; the harness executes them sequentially (deterministic ordering for the UI), then sends all results back in one user turn.
3. **Iterative refinement** — agent continues until Gemini stops emitting tool_use blocks. 10-iteration safety cap.
4. **Per-step retry** — failed tool calls retry once silently; persistent failures land in the conversation as `is_error: true` so the model can adapt (try a different query, skip the step, note the gap).
5. **Visible reasoning** — every tool call streams to the UI as a collapsible row with status icon, inputs, and result.
6. **Tools live behind MCP**, not in the extension. The extension is a generic agent host; another MCP-aware client (Claude Desktop, etc.) could use the same server unchanged.

## Tools

Five tools, exposed by the MCP server via JSON Schema. The extension fetches the schema list at popup open via MCP `tools/list`:

| Name | Backend | Notes |
|---|---|---|
| `getUpcomingMeetings` | **Google Calendar** | reads `primary` calendar, recurrences expanded, cancelled events dropped, user themselves removed from attendees, original `dateTime` offset preserved + `timeZone` field exposed. Supports `endOfToday: true` to bound the fetch to the end of the current calendar day in the user's timezone (prevents tomorrow's meetings from appearing in "today" queries) |
| `searchGmail` | **Gmail** | accepts native Gmail query syntax; returns subject / from / date / snippet for up to 20 hits |
| `searchWebInfo` | **Gemini → SerpAPI** | tiered (see below) |
| `analyzeAttendeeBackground` | **SerpAPI + Gemini** | tiered; **0 API calls** for `OWN_COMPANY_DOMAIN` attendees |
| `calculateMeetingStats` | real computation | accepts `hoursAhead` (preferred — fetches its own meetings via Calendar) or an explicit `meetings` array; returns counts, hours-per-day, busiest day, per-day load classification, per-day meeting list. All-day and multi-day events (≥ 24 h) are excluded from hour totals so they don't inflate the load numbers |

### SerpAPI / Gemini tiering

SerpAPI's free tier is 100 searches/month, so the server uses Gemini wherever Gemini is competent and only spends SerpAPI quota where it actually helps.

**`searchWebInfo`:**
- Query mentions *news / recent / latest / today / current / funding / 2026+ / etc.* → **SerpAPI directly** (Gemini's knowledge cutoff makes it useless for fresh data).
- Otherwise → **Gemini first**. If it knows the entity, return its structured answer. If it returns `_unknown` or the call fails, **fall back to SerpAPI**.

**`analyzeAttendeeBackground`:**
- Email domain in `OWN_COMPANY_DOMAIN` → **0 API calls**, return an "internal teammate" stub.
- Otherwise → **1 SerpAPI call** (the only reliable source for the LinkedIn URL — Gemini hallucinates URLs) + **1 Gemini call** to synthesize `currentRole` and `background` from the SerpAPI snippets.

A process-local LRU (`mcp-server/cache.js`, 50 entries) dedupes repeat lookups within a popup session.

## Agent loop

```
user query
    │
    ▼
detect user TZ (Intl.DateTimeFormat)
    │
    ▼
loop (max 10 iterations):
    callLLM(history, tools, {userTimeZone})
       │
       ▼
    if stop_reason != "tool_use": return final text
    for each tool_use block (sequential):
        forward to MCP server (tools/call)
        retry once on error
        push tool_result (is_error: true on persistent failure)
    push assistant turn + tool_results into history
```

- **Cap of 10 iterations** prevents runaway loops.
- **Multiple `tool_use` blocks** in one assistant turn execute **sequentially** so the reasoning-chain UI orders them deterministically.
- **Tool failures** retry once silently; persistent failures surface as `is_error: true` tool results so the model can adapt.
- **User timezone** is detected once per run via `Intl.DateTimeFormat()` and threaded into both the system prompt (brief renders meeting times in the user's local zone with abbreviation, e.g. `2:00 PM CST`) and every MCP tool call (so `calculateMeetingStats` attributes meetings to the correct local day, not the server's timezone).
- **Conversation history** is popup-scoped — closing the popup clears it.

## System prompt

The system prompt (`api.js` → `SYSTEM_PROMPT`) was rewritten in Session 5 to satisfy the **Prompt Evaluation Assistant** rubric. It is now organized into named, machine-readable sections:

1. **`# REASONING PROTOCOL`** — explicit "think step-by-step" instructions; defines the five reasoning-type tags the model must emit (`[PLAN]`, `[LOOKUP]`, `[COMPUTE]`, `[VERIFY]`, `[SYNTHESIS]`); every tag is a 1–3 sentence text block.
2. **`# SEPARATION OF REASONING AND TOOLS`** — reasoning belongs in text content; tool invocations belong in function-call blocks. The prompt shows a *correct* turn and an *incorrect* turn side-by-side.
3. **`# CONVERSATION LOOP`** — describes the alternating you / tool-result pattern across turns explicitly, with guidance on parallel calls and carrying facts forward.
4. **`# TOOLS`** — one-line purpose per tool + tool-use rules (`endOfToday` for today queries, prefer `hoursAhead` over a `meetings` array, parallel-call discipline).
5. **`# SELF-CHECKS (the [VERIFY] block)`** — 5-item checklist the model must run after every batch of tool results and one final time before the brief (TZ offsets, attendee counts, no-invented-URLs, stats sanity, coverage).
6. **`# FALLBACK RULES`** — explicit handling for tool errors, empty results, uncertain facts, conflicting sources, and the 10-turn iteration budget.
7. **`# FINAL BRIEF FORMAT`** — markdown schema for the brief: hero meta, Attendees, Company Context, Related Emails, Talking Points, Prep Checklist; multi-meeting rules.
8. **`# WORKED EXAMPLE`** — a fully rendered 5-turn example showing tagged blocks, parallel tool calls, and the final brief.
9. **`# OVERALL CLARITY`** — closing one-line rule of thumb.

Per-call: the prompt appends the user's local timezone with explicit guidance to render meeting times in that zone (e.g. `2:00 PM CST`).

The full evaluator output (before / after) and per-criterion mapping is in **[docs/prompt-evaluation.md](docs/prompt-evaluation.md)**.

### How structured reasoning shows up in the UI

The agent's text blocks now arrive with a `[TAG]` prefix. [popup.js](popup.js) `splitTaggedBlocks()` recognizes the tags and renders each block as a distinct colored row with an icon + tag pill — so the reasoning chain is a structured sequence, not a single italicized stream:

| Tag | Icon | Color | When the model emits it |
|---|---|---|---|
| `[PLAN]` | 📋 | blue | outlining the next 1–3 steps |
| `[LOOKUP]` | 🔎 | purple | immediately before a calendar / web / email / attendee tool call |
| `[COMPUTE]` | 🧮 | amber | immediately before a `calculateMeetingStats` call |
| `[VERIFY]` | ✅ | green | first block of every turn after tool results return |
| `[SYNTHESIS]` | ✍️ | red | immediately before the final markdown brief |

## UI

- **Gear popover** for the API key — saved to `chrome.storage.local`. Status dot: red = unset, green = saved.
- **Quick action buttons** plus a custom query input.
- **Reasoning chain** — every tool call rendered as a collapsible row with status icon (loading, retrying, success, error). The whole chain is also collapsible. Reasoning prose between tool calls is rendered as a collapsed "thought" with a one-line preview.
- **Brief renderer** — the model's markdown output is post-processed into structured blocks:
  - Hero card with title, gradient header, When/Where/Agenda meta strip.
  - Attendee cards with initial-letter avatar circles.
  - Email cards with date pills.
  - Talking points as numbered cards.
  - Prep checklist as checkbox-styled rows.
- **Stats card** for `calculateMeetingStats` — 2x2 metric tile grid, hours-based weekly load chart with per-day color-coded bars, collapsible day-by-day breakdown.
- **Multi-meeting briefs** — each `# Meeting Title` becomes its own collapsible card; all collapsed by default.

## Setup

### 1. Install MCP server

The server is **Python 3.12 + Pydantic v2** managed by **[uv](https://docs.astral.sh/uv/)**.

```sh
# install uv once if you don't have it (macOS/Linux):
#   curl -LsSf https://astral.sh/uv/install.sh | sh
# Windows (PowerShell):
#   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

cd mcp-server
uv sync                     # creates .venv/ and installs deps from pyproject.toml
cp .env.example .env
# fill in SERPAPI_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY),
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OWN_COMPANY_DOMAIN
uv run python server.py
```

See [mcp-server/README.md](mcp-server/README.md) for full credential walkthrough (SerpAPI signup, Google Cloud OAuth client, etc.).

The server listens on `http://localhost:3737/mcp`. Health check: `curl http://localhost:3737/health`.

### 2. Install Chrome extension

1. Get a Gemini API key from [aistudio.google.com](https://aistudio.google.com) (free tier covers this use).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the project root.
3. Click the extension icon in the toolbar.
4. Click the gear in the top-right of the popup.
5. Paste your Gemini API key (`AIza...`), click **Save**.
6. Click any quick-action button or type a custom query.

The first time `getUpcomingMeetings` or `searchGmail` is called, the MCP server auto-opens a Google consent page in your browser. Authorize once → the refresh token persists at `~/.meeting-intel-mcp/google-tokens.json` → subsequent calls are silent.

## File structure

```
eag-v3-session5/
├── manifest.json             # MV3 config (host_permissions: Gemini API + localhost:3737)
├── popup.html                # UI layout
├── popup.js                  # UI controller, brief post-processor, markdown renderer,
│                             # splitTaggedBlocks() for [PLAN]/[LOOKUP]/[VERIFY] rendering
├── styles.css                # All styles, incl. .reasoning-block--{plan,lookup,…} tints
├── agent.js                  # Agent loop (callLLM → handle tool_use → retry → loop)
├── api.js                    # Gemini wrapper + the structured-reasoning SYSTEM_PROMPT
├── tools.js                  # Thin MCP-client shim (replaces in-extension tool impls)
├── mcp-client.js             # JSON-RPC over HTTP+SSE client
├── mockData.js               # Legacy mock fixtures (no longer wired into popup.html)
├── icons/                    # Extension icons
├── docs/
│   └── prompt-evaluation.md  # Prompt Evaluation Assistant scoring (before / after)
├── README.md                 # This file
├── specification.md          # Original spec
└── mcp-server/               # Python 3.12 + Pydantic v2, managed by uv
    ├── pyproject.toml        # uv-managed dependency manifest
    ├── .python-version       # pinned to 3.12
    ├── server.py             # FastMCP + Starlette transport on /mcp; OAuth + /health routes
    ├── tools.py              # 5 async tool implementations
    ├── models.py             # Pydantic v2 I/O models (inputs + outputs)
    ├── google_auth.py        # OAuth client + ~/.meeting-intel-mcp/ token persistence
    ├── serpapi.py            # async SerpAPI client (httpx)
    ├── llm.py                # async Gemini wrapper for server-side JSON-mode calls
    ├── cache.py              # process-local LRU with in-flight dedupe
    ├── .env.example          # Required env-var template (unchanged from Node version)
    └── README.md             # Server-specific setup walkthrough
```

## Tech stack

- **Extension** — plain HTML/CSS/JavaScript, no framework, no build step. Manifest V3.
- **MCP server** — Python 3.12, ES-module-equivalent (PEP 621 `[project]`), `mcp` (official Python SDK), `pydantic` v2, `starlette`, `uvicorn`, `httpx`, `google-api-python-client`, `google-auth-oauthlib`, `python-dotenv`. Managed by **[uv](https://docs.astral.sh/uv/)**; see [mcp-server/pyproject.toml](mcp-server/pyproject.toml).
- **LLM** — Gemini 2.5 Flash for the agent loop (extension) and for server-side reasoning (server). The same key works in both places.
- **External APIs** — Google Calendar, Gmail, SerpAPI (Google SERP).
- **Persistence** — `chrome.storage.local` (Gemini key for the agent), `~/.meeting-intel-mcp/google-tokens.json` (OAuth refresh token; format is intentionally compatible with the legacy Node server), `mcp-server/.env` (server-side API keys + config).

## Limitations

- **Single user, single device.** API keys live in extension storage and `.env`; not multi-tenant safe. The OAuth client is per-user.
- **Local MCP server.** The extension talks to `localhost:3737`. Stop the server → tools fail with a clear "MCP server not running" error.
- **No conversation persistence.** Each popup session is independent; closing the popup loses history.
- **No streaming.** Each LLM turn is a buffered POST/response cycle.
- **Gemini knowledge cutoff** — `searchWebInfo`'s Gemini-first tier can be wrong for entities created/changed after the cutoff. Freshness keywords route to SerpAPI as a workaround, and Gemini's `_unknown` answer triggers SerpAPI fallback automatically.
- **SerpAPI free tier is 100 searches/month** — the tiering keeps usage low (most lookups go to Gemini), but heavy daily use will exhaust it. Upgrade to a paid SerpAPI plan or swap providers in [mcp-server/serpapi.py](mcp-server/serpapi.py).

## Future enhancements

### Short term

- **Real web search beyond Google SERP** — [mcp-server/serpapi.py](mcp-server/serpapi.py) is a thin adapter; swapping for Tavily, Brave, or a self-hosted SearXNG is a one-file change.
- **Recent-news enrichment** — populate `recentNews[]` for `searchWebInfo` companies via a SerpAPI news-engine call (currently empty by default).
- **Streaming responses** — switch to Server-Sent Events for the Gemini call so reasoning prose shows token-by-token within a turn.
- **Conversation persistence** — move the agent loop into a background service worker so long-running tasks survive popup close.

### Medium term

- **Action tools, not just read tools** — `draftEmailReply`, `proposeMeetingTime`, `addToCalendar`, `bookFollowUp` — so the agent can act, not just inform.
- **Cross-meeting context** — surface email threads or shared attendees that span multiple upcoming meetings.
- **Pre-warming** — background fetch the next meeting and pre-compute a brief on a schedule so the popup opens with the brief already prepared.
- **Settings beyond the API key** — model picker, iteration cap, default lookahead window, per-tool mock-vs-live toggle.
- **Caching beyond the LRU** — Gemini context caching for the system prompt + tool declarations (cheap once warmed).
- **Provider abstraction** — formalize the `api.js` translation layer into a pluggable adapter (Gemini / Anthropic / OpenAI) selectable from settings.

### Longer term

- **Drop-in to other MCP hosts** — the server already speaks streamable-HTTP MCP; pointing Claude Desktop or Cursor at `http://localhost:3737/mcp` should work out of the box.
- **Multi-turn refinement in-popup** — chat back and forth with the agent, not just one query → one brief.
- **Voice input** via Web Speech API.
- **Distribution via Chrome Web Store** with a hosted MCP server + proxied API keys so users don't have to bring their own.
- **Evals** — a fixed set of meeting scenarios + golden briefs, run on CI to catch regressions when the model, tools, or system prompt change.
