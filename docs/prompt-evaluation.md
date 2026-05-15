# Prompt Qualification (Session 5)

This document captures how the agent's system prompt was scored against the **Prompt Evaluation Assistant** rubric, before and after the Session 5 upgrade. The rubric scores nine criteria — the goal of this upgrade was to move every criterion from a `false` / partial to a `true`.

## The evaluator rubric

The evaluator (a separate LLM prompted to act as a "Prompt Evaluation Assistant") scores a prompt across nine criteria and returns a JSON verdict:

```
1. Explicit Reasoning Instructions    — does the prompt say "think step-by-step"?
2. Structured Output Format           — is output predictable / parseable?
3. Separation of Reasoning and Tools  — reasoning vs. tool-use kept distinct?
4. Conversation Loop Support          — works in multi-turn?
5. Instructional Framing              — examples of desired behavior?
6. Internal Self-Checks               — model is told to sanity-check itself?
7. Reasoning Type Awareness           — tags type of reasoning (logic, lookup, …)?
8. Error Handling or Fallbacks        — what to do when uncertain / tool fails?
9. Overall Clarity and Robustness     — reduces hallucination and drift?
```

---

## Before (Session 4 prompt)

The Session 4 prompt is preserved verbatim in [the git history](../api.js) (see `git log api.js`). It described the five tools, the operating rules, and the markdown brief format — but it did not name reasoning types, did not require a self-check step, and gave no worked example.

**Evaluator verdict (run by Claude acting as the Prompt Evaluation Assistant):**

```json
{
  "explicit_reasoning": false,
  "structured_output": true,
  "tool_separation": false,
  "conversation_loop": true,
  "instructional_framing": true,
  "internal_self_checks": false,
  "reasoning_type_awareness": false,
  "fallbacks": true,
  "overall_clarity": "Clear and well-organized for the brief output format, but lacks explicit step-by-step reasoning, structured separation between reasoning and tool calls, internal self-checks, and reasoning-type tagging. The agent is told what to do but not how to think before doing it."
}
```

**Score: 4 of 8 boolean criteria true.** Gaps: explicit reasoning, reasoning↔tool separation, self-checks, reasoning-type awareness.

---

## After (Session 5 prompt — current `SYSTEM_PROMPT` in [api.js](../api.js))

The upgraded prompt adds five named, machine-readable sections:

- **`# REASONING PROTOCOL`** — explicit step-by-step instructions, names the five tags the model must use (`[PLAN]`, `[LOOKUP]`, `[COMPUTE]`, `[VERIFY]`, `[SYNTHESIS]`).
- **`# SEPARATION OF REASONING AND TOOLS`** — tagged reasoning lives in text content; tool invocations live in function-call blocks; the prompt shows a correct turn and an incorrect turn.
- **`# CONVERSATION LOOP`** — describes the alternating you / tool-result pattern across turns explicitly.
- **`# SELF-CHECKS (the [VERIFY] block)`** — a 5-item checklist the model must run after every batch of tool results and one final time before the brief.
- **`# FALLBACK RULES`** — explicit handling for tool errors, empty results, uncertain facts, conflicting sources, and the iteration budget.
- **`# WORKED EXAMPLE`** — a fully rendered 5-turn example showing exactly how the tagged blocks interleave with tool calls.

**Evaluator verdict (same evaluator, run against the new prompt):**

```json
{
  "explicit_reasoning": true,
  "structured_output": true,
  "tool_separation": true,
  "conversation_loop": true,
  "instructional_framing": true,
  "internal_self_checks": true,
  "reasoning_type_awareness": true,
  "fallbacks": true,
  "overall_clarity": "Excellent — the prompt explicitly names a reasoning protocol with five tagged block types, separates reasoning text from tool-call function blocks with a correct/incorrect example, includes a 5-item self-check checklist that must run after every tool result, defines fallback behavior for tool errors / empty results / uncertain facts / conflicts / iteration cap, and ships a fully worked multi-turn example. Hallucination risk is reduced by the explicit 'do not invent URLs' rule, the (unverified) tagging convention, and the [VERIFY] gate before the FINAL brief."
}
```

**Score: 8 of 8 boolean criteria true.**

---

## Per-criterion mapping

This table shows exactly which section of the new prompt addresses each criterion. Read alongside [api.js](../api.js) `SYSTEM_PROMPT`.

| # | Criterion | Where it's addressed in the new prompt |
|---|---|---|
| 1 | **Explicit reasoning instructions** | `# REASONING PROTOCOL` — "Think step-by-step. On every turn, BEFORE calling any tool, emit one or more tagged reasoning blocks…" |
| 2 | **Structured output format** | `# REASONING PROTOCOL` (tag taxonomy) + `# FINAL BRIEF FORMAT` (markdown schema). Every block has a parseable `[TAG]` prefix the UI in [popup.js](../popup.js) splits and renders distinctly. |
| 3 | **Separation of reasoning and tools** | `# SEPARATION OF REASONING AND TOOLS` — reasoning in text content, tools in function-call blocks. Includes a correct-vs-incorrect turn example. |
| 4 | **Conversation loop support** | `# CONVERSATION LOOP` — describes the alternating Turn N / Turn N+1 pattern, instructs the model to carry facts forward and not re-fetch. |
| 5 | **Instructional framing** | `# WORKED EXAMPLE` — a 5-turn rendered example showing tagged blocks, parallel tool calls, and the final brief. |
| 6 | **Internal self-checks** | `# SELF-CHECKS` — a 5-item checklist (times have TZ offsets, attendee counts match, URLs from tools only, stats sanity, coverage). Must run after every tool result and one final time before the brief. |
| 7 | **Reasoning type awareness** | `# REASONING PROTOCOL` defines five tags by cognitive type: `[PLAN]` (planning), `[LOOKUP]` (retrieval), `[COMPUTE]` (delegated arithmetic), `[VERIFY]` (sanity-check), `[SYNTHESIS]` (composition). Every reasoning block names its type. |
| 8 | **Error handling / fallbacks** | `# FALLBACK RULES` — separate guidance for tool errors, empty results, uncertain facts, conflicting sources, and hitting the iteration budget. |
| 9 | **Overall clarity** | Sections are separated by `===` rules, each has a single concern, the prompt ends with a one-line rule-of-thumb the model can fall back to. |

---

## How to reproduce the evaluator run

The evaluator is a prompt, not a tool. To re-score either prompt yourself:

1. Open any LLM with a fresh context (ChatGPT, Claude, Cursor, Gemini).
2. Paste the evaluator's instructions (the "You are a Prompt Evaluation Assistant…" block from the Session 5 brief).
3. Paste the prompt being evaluated as the next message.
4. The LLM returns the JSON verdict.

The verdicts above were produced by running the evaluator against the exact `SYSTEM_PROMPT` strings in `api.js` at the Session 4 commit (`627e121`) and the Session 5 HEAD respectively.

---

## How the tagged blocks show up at runtime

When the agent emits `[PLAN] Fetch the calendar first…`, [popup.js](../popup.js) in `splitTaggedBlocks()` recognizes the tag, picks the matching icon + color from `REASONING_TAGS`, and renders the block as a colored collapsible row with a tag pill:

- 📋 `PLAN`      — blue
- 🔎 `LOOKUP`    — purple
- 🧮 `COMPUTE`   — amber
- ✅ `VERIFY`    — green
- ✍️ `SYNTHESIS` — red

This is the *visible* evidence the prompt is working: the reasoning chain in the UI is no longer one homogeneous stream of italicized thoughts but a structured sequence of typed steps, with every tool call sandwiched between the `[LOOKUP]` / `[COMPUTE]` that motivates it and the `[VERIFY]` that audits its result.
