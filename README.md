# Meeting Intelligence Agent

A Chrome extension that prepares you for upcoming meetings by autonomously gathering context — calendar, email, attendee profiles, company info — and synthesizing it into an actionable brief. Built on Google Gemini 2.5 Flash with a custom multi-step agent loop. Tools live in a local MCP server that hits real APIs (Google Calendar, Gmail, SerpAPI, Gemini for synthesis).

## What it does

Ask it questions like:

- *Prepare me for my next meeting*
- *Show me all meetings today and research the attendees*
- *What's my meeting load this week?*

It plans, calls 3–7 tools (calendar, email, web/LinkedIn, attendee profiles, stats), and returns a structured markdown brief with attendee cards, talking points, and a prep checklist.

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
│ Local MCP Server (Node.js)                  │         │   │   │
│                                             │         │   │   │
│  index.js   express + StreamableHTTP         │         │   │   │
│  server.js  McpServer + tool registry       │         │   │   │
│  handlers.js                                 │ ────────┘   │   │
│   ├ getUpcomingMeetings  ──→ Calendar      ─┼─────────────┘   │
│   ├ searchGmail          ──→ Gmail         ─┼─────────────────┘
│   ├ searchWebInfo        ──→ Gemini→SerpAPI │
│   ├ analyzeAttendeeBackground ─→ SerpAPI+Gemini
│   └ calculateMeetingStats ─→ pure compute   │
│                                             │
│  google-auth.js  OAuth + token persistence  │
│  serpapi.js / llm.js / cache.js             │
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

The system prompt (`api.js`):

- Names the 5 tools with a one-line purpose each.
- Encourages **parallel tool calls** to fit within the iteration cap.
- Tells the model to **prefer `hoursAhead` over a `meetings` array** for `calculateMeetingStats` — passing a long array as a function-call argument can blow the output token budget.
- Tells the model to **use `endOfToday: true`** for "today" queries so the calendar fetch stops at local midnight instead of now + 24 h.
- Instructs the model to include a **per-day breakdown** (meeting count + hours per day) in all meeting-load/stats responses, alongside the overall summary.
- Specifies the markdown structure of the final brief: hero meta line, Attendees, Company Context, Related Emails, Talking Points, Prep Checklist.
- Instructs the model to use a separate `# Title` heading per meeting in multi-meeting briefs (the UI groups everything under one `#` into a collapsible card).
- Per-call: appends the user's local timezone with explicit guidance to render meeting times in that zone (e.g. `2:00 PM CST`).

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

```sh
cd mcp-server
npm install
cp .env.example .env
# fill in SERPAPI_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY),
# GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OWN_COMPANY_DOMAIN
npm start
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
session-4/
├── manifest.json             # MV3 config (host_permissions: Gemini API + localhost:3737)
├── popup.html                # UI layout
├── popup.js                  # UI controller, brief post-processor, markdown renderer
├── styles.css                # All styles
├── agent.js                  # Agent loop (callLLM → handle tool_use → retry → loop)
├── api.js                    # Gemini wrapper, Anthropic↔Gemini translation, system prompt,
│                             # JSON-Schema sanitizer for Gemini's OpenAPI subset
├── tools.js                  # Thin MCP-client shim (replaces in-extension tool impls)
├── mcp-client.js             # JSON-RPC over HTTP+SSE client
├── mockData.js               # Legacy mock fixtures (no longer wired into popup.html)
├── icons/                    # Extension icons
├── README.md                 # This file
├── specification.md          # Original spec
└── mcp-server/
    ├── package.json          # Node deps: @modelcontextprotocol/sdk, googleapis, express, ...
    ├── index.js              # Express + StreamableHTTP transport, OAuth routes
    ├── server.js             # McpServer + 5 tool registrations (Zod schemas)
    ├── handlers.js           # Tool implementations
    ├── google-auth.js        # OAuth client + ~/.meeting-intel-mcp/ token persistence
    ├── serpapi.js            # SerpAPI client (Google engine)
    ├── llm.js                # Gemini wrapper for server-side JSON-mode calls
    ├── cache.js              # Process-local LRU
    ├── .env.example          # Required env-var template
    └── README.md             # Server-specific setup walkthrough
```

## Tech stack

- **Extension** — plain HTML/CSS/JavaScript, no framework, no build step. Manifest V3.
- **MCP server** — Node.js 18+, ES modules, `@modelcontextprotocol/sdk`, `express`, `googleapis`, `zod`, `dotenv`.
- **LLM** — Gemini 2.5 Flash for the agent loop (extension) and for server-side reasoning (server). The same key works in both places.
- **External APIs** — Google Calendar, Gmail, SerpAPI (Google SERP).
- **Persistence** — `chrome.storage.local` (Gemini key for the agent), `~/.meeting-intel-mcp/google-tokens.json` (OAuth refresh token), `mcp-server/.env` (server-side API keys + config).

## Limitations

- **Single user, single device.** API keys live in extension storage and `.env`; not multi-tenant safe. The OAuth client is per-user.
- **Local MCP server.** The extension talks to `localhost:3737`. Stop the server → tools fail with a clear "MCP server not running" error.
- **No conversation persistence.** Each popup session is independent; closing the popup loses history.
- **No streaming.** Each LLM turn is a buffered POST/response cycle.
- **Gemini knowledge cutoff** — `searchWebInfo`'s Gemini-first tier can be wrong for entities created/changed after the cutoff. Freshness keywords route to SerpAPI as a workaround, and Gemini's `_unknown` answer triggers SerpAPI fallback automatically.
- **SerpAPI free tier is 100 searches/month** — the tiering keeps usage low (most lookups go to Gemini), but heavy daily use will exhaust it. Upgrade to a paid SerpAPI plan or swap providers in `serpapi.js`.

## Future enhancements

### Short term

- **Real web search beyond Google SERP** — `serpapi.js` is a thin adapter; swapping for Tavily, Brave, or a self-hosted SearXNG is a one-file change.
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
