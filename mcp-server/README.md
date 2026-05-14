# Meeting Intelligence MCP Server

Local MCP server that exposes the 5 meeting-intelligence tools used by the Chrome extension. Speaks streamable-HTTP MCP on `POST /mcp`.

## Run

```sh
cd mcp-server
npm install
cp .env.example .env   # then fill in BRAVE_API_KEY
npm start
```

Listens on `http://localhost:3737`. Health check: `curl http://localhost:3737/health`.

## Configure (.env)

Copy `.env.example` to `.env` and fill in:

- **`SERPAPI_API_KEY`** — required for `searchWebInfo` and `analyzeAttendeeBackground` (when they actually need to hit the web — see [tiering](#serpapi--gemini-tiering) below). Sign up at [serpapi.com](https://serpapi.com), the Free plan gives 100 searches/month and 250/hour.

- **`GEMINI_API_KEY`** — required for the Gemini-first path on `searchWebInfo` and the profile synthesis in `analyzeAttendeeBackground`. Get a key at [aistudio.google.com](https://aistudio.google.com). The extension also uses its own copy of this key (stored in `chrome.storage.local`).

- **`OWN_COMPANY_DOMAIN`** — *optional*, comma-separated list of email domains to treat as internal (e.g. `acme.com,acme.io`). External research is skipped for matching attendees, saving SerpAPI quota. Leave blank to disable.

- **`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`** — required for `getUpcomingMeetings` (Calendar) and `searchGmail` (Gmail).

  1. Open [Google Cloud Console](https://console.cloud.google.com) → create or pick a project.
  2. **APIs & Services → Library** → enable **both** the **Google Calendar API** and the **Gmail API**.
  3. **APIs & Services → OAuth consent screen** → choose **External** → fill in app name + your email → add your own Google account as a **test user**.
  4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → choose **Desktop**. Copy the client ID + client secret into `.env`.

  No redirect URI registration needed — Desktop OAuth clients accept any loopback (`http://localhost:*`).

Without keys, the affected tools surface a clear error to the agent; the rest still work on their mock data.

## First-time Google authorization

The first time a Google-backed tool is called:

1. The server auto-opens a browser to Google's consent screen (or prints the URL if it can't).
2. You consent → Google redirects to `http://localhost:3737/oauth/google/callback`.
3. Server stores the refresh token at `~/.meeting-intel-mcp/google-tokens.json` (chmod 600 on POSIX).
4. Retry your query in the extension — subsequent calls auto-refresh access tokens silently.

Each tool requests only the scope it needs (`calendar.readonly` or `gmail.readonly`). If `searchGmail` runs after only Calendar has been authorized, the server triggers a re-auth that **merges** stored + requested scopes — so you keep Calendar access and add Gmail in one trip.

To pre-authorize everything in one click before triggering the agent: visit `http://localhost:3737/auth/google` directly.

To re-authorize from scratch (different Google account, etc.): delete `~/.meeting-intel-mcp/google-tokens.json` and call the tool again.

## Tools

| Name | Backend | Notes |
|---|---|---|
| `getUpcomingMeetings` | **Google Calendar** | reads `primary` calendar, recurrences expanded, cancelled events dropped, user themselves removed from attendees |
| `searchGmail` | **Gmail** | accepts native Gmail query syntax; returns subject / from / date / snippet for up to 20 hits |
| `searchWebInfo` | **Gemini → SerpAPI** | tiered (see below) |
| `analyzeAttendeeBackground` | **SerpAPI + Gemini** | tiered (see below); 0 API calls for internal attendees |
| `calculateMeetingStats` | real computation | unchanged |

## SerpAPI / Gemini tiering

SerpAPI's free tier is 100 searches/month, so the server uses Gemini wherever Gemini is competent and only spends SerpAPI quota where it actually helps.

**`searchWebInfo`:**

- Query mentions *news / recent / latest / today / current / funding / 2026+ / etc.* → **SerpAPI directly** (Gemini's knowledge cutoff makes it useless for fresh data).
- Otherwise → **Gemini first**. If Gemini knows the entity, return its structured answer. If it returns `_unknown` or the call fails, **fall back to SerpAPI**.

**`analyzeAttendeeBackground`:**

- Email domain in `OWN_COMPANY_DOMAIN` → **0 API calls**, return an "internal teammate" stub.
- Otherwise → **1 SerpAPI call** (the only reliable source for the LinkedIn URL — Gemini hallucinates URLs) + **1 Gemini call** to synthesize `currentRole` and `background` from the SerpAPI snippets.

**LRU cache** ([cache.js](cache.js)): every external lookup is keyed by `(tool, args)` and cached in-process for the lifetime of the server. Repeat queries within a popup session pay nothing — useful when one company turns up across multiple tool calls. Cap: 50 entries.

## Files

- `index.js` — Express + StreamableHTTP transport on `/mcp` (stateless mode); loads `.env` first; mounts `/auth/google` and `/oauth/google/callback`.
- `server.js` — Builds an `McpServer` and registers all 5 tools with Zod schemas.
- `handlers.js` — Tool implementations + remaining mock fixtures (only `searchGmail` is mocked now).
- `serpapi.js` — SerpAPI client (Google engine). Flattens `organic_results` into `{title, description, url}`.
- `llm.js` — Gemini wrapper for server-side reasoning calls (`geminiAskJson`, JSON-mode, low temperature).
- `cache.js` — process-local LRU used by `searchWebInfo` and `analyzeAttendeeBackground` to dedupe repeat lookups within a session.
- `google-auth.js` — OAuth2 client, token persistence at `~/.meeting-intel-mcp/google-tokens.json`, auto-opens consent browser on first use.
- `.env.example` — template for required environment variables.

## Quick test

```sh
# initialize
curl -s -X POST http://localhost:3737/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# list tools
curl -s -X POST http://localhost:3737/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# call a tool
curl -s -X POST http://localhost:3737/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"getUpcomingMeetings","arguments":{"hoursAhead":24}}}'
```
