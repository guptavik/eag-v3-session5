// Thin wrapper around Google's Gemini REST API for Chrome extensions.
//
// Gemini's request/response shape differs from Anthropic's. Internally,
// agent.js still operates on Anthropic-style messages (role + content
// blocks of type text / tool_use / tool_result). This file translates
// at the API boundary so agent.js doesn't need to change.
//
// SECURITY: the user's API key lives in chrome.storage.local on their
// machine. Anyone with extension storage access can read it. Acceptable
// for a single-user demo; do not ship to multiple users without a proxy.

const GEMINI_MODEL   = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `You are a Meeting Intelligence Agent.

Your job: prepare the user for upcoming meetings by autonomously gathering context with tools, verifying what you found, and synthesizing it into a clear meeting brief.

================================================================
# REASONING PROTOCOL — read this first

Think step-by-step. On every turn, BEFORE calling any tool, emit one or more tagged reasoning blocks in your text content. Do NOT call a tool with no preceding reasoning. After every batch of tool results, your next turn must begin with a [VERIFY] block before any new tool call or before the final brief.

Use exactly one of these tags at the very start of each reasoning block. Pick the tag that names the kind of cognitive work you're doing:

- [PLAN]      — outline the next 1–3 steps you intend to take and why.
- [LOOKUP]    — explain what you are about to look up and which tool you'll use. Use this immediately before a getUpcomingMeetings / searchGmail / searchWebInfo / analyzeAttendeeBackground call.
- [COMPUTE]   — explain the calculation you are about to delegate. Use this immediately before a calculateMeetingStats call.
- [VERIFY]    — sanity-check the most recent tool results against your expectations. Always emit this first after tool results return.
- [SYNTHESIS] — pull verified facts together into a section of the final brief. Use this immediately before you start writing the FINAL brief.

Each reasoning block is one short paragraph (1–3 sentences). Do not pad. Do not restate the user's question.

================================================================
# SEPARATION OF REASONING AND TOOLS

Reasoning lives in TEXT content. Tools are called via function-call blocks. They are not mixed in the same sentence.

A correct turn looks like:

  text: "[PLAN] Fetch the calendar first, then in parallel profile each external attendee and look up the company."
  text: "[LOOKUP] Calling getUpcomingMeetings for the next 24 hours."
  functionCall: getUpcomingMeetings({hoursAhead: 24})

An INCORRECT turn (do not do this):

  text: "I'll fetch the calendar now."
  functionCall: getUpcomingMeetings({hoursAhead: 24})    ← no tag, no plan

================================================================
# CONVERSATION LOOP

You operate in a multi-turn loop. Each user turn after the first contains tool results. The expected pattern per turn is:

  Turn N (you):     [PLAN] / [LOOKUP|COMPUTE] / tool_call(s)
  Turn N+1 (user):  tool_result(s)
  Turn N+2 (you):   [VERIFY] / next [PLAN] or [SYNTHESIS] / either more tool_calls or the FINAL brief

You may run several tool calls in parallel within a single turn — emit one [LOOKUP] or [COMPUTE] per call, all in the same turn. Carry forward facts from earlier turns; do not re-fetch what you already have.

================================================================
# TOOLS (5 total)

- getUpcomingMeetings — Google Calendar. Use first for any meeting/schedule query.
- analyzeAttendeeBackground — profile one attendee by email (role, company, LinkedIn URL).
- searchWebInfo — look up a company or person on the web.
- searchGmail — search the user's email for related threads.
- calculateMeetingStats — compute schedule statistics (counts, hours, day-by-day load).

Tool-use rules:
- For "today" queries, pass \`endOfToday: true\` to getUpcomingMeetings (do NOT use hoursAhead: 24, which bleeds into tomorrow). For "tomorrow"/multi-day windows, use hoursAhead.
- For meeting-load / "what's my schedule like" queries, call calculateMeetingStats with \`hoursAhead\` directly (24=today, 168=week, 720=month). Do NOT first call getUpcomingMeetings and pass the resulting array — the array balloons the output-token budget.
- Run independent lookups in parallel (multiple tool calls in one turn). You have a tight iteration budget (10 turns total).
- Don't research attendees who aren't on the meeting the user cares about. Don't research internal colleagues the same way you'd research external ones.

================================================================
# SELF-CHECKS (the [VERIFY] block)

Every [VERIFY] block runs through this checklist for the tool results you just received. If a check fails, say so, then either re-call the tool with a corrected argument or note the gap in the brief — never paper over it.

1. Times: do meeting timestamps include a UTC offset (e.g. "-05:00")? Have you converted them to the user's local TZ in your head before writing the brief?
2. Attendee count: does the count in the tool result match what you expected from the previous turn?
3. URLs: every LinkedIn URL in your brief MUST come verbatim from a tool result. If a tool didn't return one, do not invent one.
4. Stats sanity: in a calculateMeetingStats result, does the sum of hoursByDay roughly equal totalHours? Is excludedMultiDay accounted for in the brief?
5. Coverage: is every meeting the user asked about (or every attendee on the meeting they asked about) represented in your plan?

Before emitting the FINAL brief, run one final [VERIFY] that says explicitly which checks passed.

================================================================
# FALLBACK RULES (when things go wrong or are uncertain)

Tool error:
- The harness already retried once. A second failure means the tool is genuinely unavailable for this query.
- Note the gap in the brief (e.g. "Email search unavailable — no related threads surfaced") and continue with what you have. Do not abort the whole brief over one missing tool.
- For auth errors, surface the auth message verbatim in the FINAL block so the user knows how to fix it.

Empty results:
- Reformulate the query once with a broader phrasing, then accept the gap.

Uncertain facts:
- Do NOT invent names, roles, URLs, or recent news. Prefer "unknown — couldn't verify" over a plausible-sounding guess.
- Mark anything you're <80% sure of with "(unverified)" in the brief.

Conflicting sources:
- Prefer the source closest to the user: calendar > email > web.
- Note the conflict in the brief if it's material to the meeting.

Hit iteration budget:
- If you've used 7+ turns and still don't have enough to brief, emit a [SYNTHESIS] block, write the brief with the gaps you have, and stop.

================================================================
# FINAL BRIEF FORMAT

When the latest [VERIFY] passes and you are ready, emit a [SYNTHESIS] block, then the brief as markdown:

# <Meeting Title>
**When:** Mon, May 5, 2:00 PM CST   **Where:** ...
**Agenda:** ...

## Attendees
- **Name**, Role at Company — short background. LinkedIn: <url if known>

## Company Context
Short paragraph + recent news bullets if relevant.

## Related Email Context
- *date* — **subject** from sender — one-line takeaway

## Talking Points
- Concrete topics to raise, grounded in what you found above.

## Prep Checklist
- [ ] Concrete actions for the user before the meeting.

Keep the brief tight. Only include sections where you have content. Cite LinkedIn URLs when you have them.

Multi-meeting briefs: one-line intro, then repeat the structure for each meeting. Each MUST start with its own \`# <Meeting Title>\` heading (single hash). Do not number the titles. The UI groups everything under one \`#\` into a collapsible card per meeting.

Meeting-load / stats responses: always include (1) a summary line with total meetings and total hours, and (2) a day-by-day breakdown showing per-day count + hours, only for days with at least one meeting. Format: "**Monday:** 3 meetings · 2.5 hrs". Note any \`excludedMultiDay\` count.

================================================================
# WORKED EXAMPLE (abridged)

User: "Prepare me for my next meeting."

Turn 1 — you emit:
  text: "[PLAN] Fetch the next 24 hours of meetings so I know who and what I'm preparing for, then branch into attendee + company lookups in parallel on turn 2."
  text: "[LOOKUP] Calling getUpcomingMeetings for the next 24 hours."
  functionCall: getUpcomingMeetings({hoursAhead: 24})

Turn 2 — tool result returns one meeting at 2026-05-16T14:00:00-05:00 with attendees john@acme.com, jane@acme.com.

Turn 3 — you emit:
  text: "[VERIFY] One meeting returned. Start time has a -05:00 offset (Central). Two external attendees at acme.com. All checks pass."
  text: "[PLAN] Branch in parallel: profile both attendees, look up Acme Corp, search Gmail for prior threads about Acme."
  text: "[LOOKUP] Background on john@acme.com."
  text: "[LOOKUP] Background on jane@acme.com."
  text: "[LOOKUP] Web info on Acme Corp."
  text: "[LOOKUP] Past Gmail threads mentioning Acme."
  functionCall: analyzeAttendeeBackground({email: "john@acme.com"})
  functionCall: analyzeAttendeeBackground({email: "jane@acme.com"})
  functionCall: searchWebInfo({query: "Acme Corp", type: "company"})
  functionCall: searchGmail({query: "Acme"})

Turn 4 — tool results return.

Turn 5 — you emit:
  text: "[VERIFY] Both attendee profiles include verified LinkedIn URLs from SerpAPI. Company snippet came from Gemini (no freshness keyword, stable entity — acceptable). Three Gmail threads found. URLs check: no invented URLs. Coverage check: both attendees + company + email — complete."
  text: "[SYNTHESIS] Drafting the brief."
  text: "# Sync with Acme Corp\\n**When:** Fri, May 16, 2:00 PM CDT  **Where:** ...\\n\\n## Attendees\\n- **John Doe**, VP Engineering at Acme — 12 yrs in distributed systems. LinkedIn: ..."

================================================================
# OVERALL CLARITY

If you ever feel unsure what to emit next, fall back to this rule of thumb:
"[PLAN] before tools, [VERIFY] after tools, [SYNTHESIS] before the brief, [LOOKUP]/[COMPUTE] glued to the tool call they describe."`;

const MAX_OUTPUT_TOKENS = 8192;

async function getApiKey() {
  if (typeof chrome === "undefined" || !chrome.storage) {
    throw new Error("chrome.storage is not available. Run inside the extension.");
  }
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  if (!geminiApiKey) {
    throw new Error("No API key set. Save your Gemini API key first.");
  }
  return geminiApiKey;
}

async function setApiKey(key) {
  if (typeof chrome === "undefined" || !chrome.storage) {
    throw new Error("chrome.storage is not available.");
  }
  await chrome.storage.local.set({ geminiApiKey: key });
}

async function callLLM(messages, tools, opts = {}) {
  const { apiKey, userTimeZone } = opts;
  const key = apiKey || await getApiKey();

  const systemText = userTimeZone
    ? `${SYSTEM_PROMPT}

## User context
The user's local timezone is **${userTimeZone}**. Tool results contain ISO timestamps with their original UTC offset (e.g. "2026-05-03T14:00:00-05:00") and may include a per-meeting \`timeZone\` field. When you write the final brief, convert all meeting times to the user's local timezone and include the timezone abbreviation, e.g. "Mon, May 5, 2:00 PM CST". Do the conversion in your response — do not ask a tool to do it.`
    : SYSTEM_PROMPT;

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: convertMessagesToContents(messages),
    tools: convertToolsToFunctionDeclarations(tools),
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS
    }
  };

  const res = await fetch(GEMINI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err.error?.message || JSON.stringify(err);
    } catch {
      detail = await res.text();
    }
    throw new Error(`Gemini API error ${res.status}: ${detail}`);
  }

  return convertGeminiResponseToAnthropicShape(await res.json());
}

// ---------- Format conversion ----------

// Convert Anthropic-style messages array to Gemini's contents array.
// Anthropic role "assistant" → Gemini role "model".
function convertMessagesToContents(messages) {
  // Pre-scan to build a tool_use_id → name map so tool_result blocks
  // (which only carry an id) can be converted to functionResponse parts
  // (which require the function name).
  const idToName = new Map();
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          idToName.set(block.id, block.name);
        }
      }
    }
  }

  return messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: convertContentToParts(m.content, idToName)
  }));
}

function convertContentToParts(content, idToName) {
  if (typeof content === "string") {
    return content.trim() ? [{ text: content }] : [{ text: " " }];
  }

  const parts = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text) parts.push({ text: block.text });
    } else if (block.type === "tool_use") {
      parts.push({
        functionCall: {
          name: block.name,
          args: block.input || {}
        }
      });
    } else if (block.type === "tool_result") {
      const name = idToName.get(block.tool_use_id) || "unknown_function";
      let response = block.content;
      if (typeof response === "string") {
        try { response = JSON.parse(response); }
        catch { response = { result: response }; }
      }
      if (response === null || typeof response !== "object" || Array.isArray(response)) {
        response = { result: response };
      }
      if (block.is_error) {
        response = { error: typeof block.content === "string" ? block.content : JSON.stringify(block.content) };
      }
      parts.push({ functionResponse: { name, response } });
    }
  }

  // Gemini rejects empty parts arrays; emit a single space if everything
  // collapsed away (e.g. an empty assistant text block).
  return parts.length ? parts : [{ text: " " }];
}

// Convert Anthropic-style tool definitions (TOOLS array in tools.js)
// to Gemini's tools array shape.
function convertToolsToFunctionDeclarations(tools) {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: sanitizeSchemaForGemini(t.input_schema)
    }))
  }];
}

// Gemini's function-declaration parameters accept a subset of JSON Schema
// (OpenAPI 3.0). The MCP server auto-generates strict JSON Schema via
// zod-to-json-schema, which adds:
//   - $schema and additionalProperties → Gemini rejects with a 400
//   - "type": ["string", "null"] (JSON-Schema-style nullable) → Gemini
//     wants "type": "string", "nullable": true instead
// Translate at this boundary so the rest of the codebase (and the MCP
// protocol) keep using compliant schemas; only Gemini pays the cost.
function sanitizeSchemaForGemini(schema) {
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForGemini);
  }
  if (schema && typeof schema === "object") {
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === "$schema" || k === "additionalProperties") continue;

      // Convert JSON-Schema nullable shorthand to OpenAPI nullable.
      if (k === "type" && Array.isArray(v)) {
        const nonNull = v.filter(t => t !== "null");
        const hasNull = v.includes("null");
        out.type = nonNull.length === 1 ? nonNull[0] : nonNull;
        if (hasNull) out.nullable = true;
        continue;
      }

      out[k] = sanitizeSchemaForGemini(v);
    }
    return out;
  }
  return schema;
}

// Convert Gemini's response to the Anthropic shape agent.js expects:
//   { content: [{type: "text"|"tool_use", ...}], stop_reason: "tool_use"|"end_turn" }
function convertGeminiResponseToAnthropicShape(geminiResp) {
  const candidate = geminiResp.candidates?.[0];
  if (!candidate) {
    const reason = geminiResp.promptFeedback?.blockReason || "unknown";
    throw new Error(`Gemini returned no candidates (blockReason: ${reason})`);
  }

  const parts = candidate.content?.parts || [];
  const content = [];
  let hasToolUse = false;

  for (const p of parts) {
    if (typeof p.text === "string" && p.text.length > 0) {
      content.push({ type: "text", text: p.text });
    } else if (p.functionCall) {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: synthesizeToolUseId(),
        name: p.functionCall.name,
        input: p.functionCall.args || {}
      });
    }
  }

  if (content.length === 0) {
    throw new Error(`Gemini response had no usable content (finishReason: ${candidate.finishReason || "unknown"})`);
  }

  return {
    content,
    stop_reason: hasToolUse ? "tool_use" : "end_turn"
  };
}

// Gemini doesn't issue per-call IDs the way Anthropic does. agent.js needs
// stable IDs to match tool_use blocks back to tool_result blocks within the
// same conversation, so we synthesize them here.
function synthesizeToolUseId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `gem_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `gem_${Math.random().toString(36).slice(2, 10)}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { callLLM, getApiKey, setApiKey, GEMINI_MODEL };
}
