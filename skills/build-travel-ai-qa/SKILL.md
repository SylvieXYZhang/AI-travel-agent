---
name: build-travel-ai-qa
description: Build or replace a travel product's mock chatbot with a production-oriented LLM API, retrieval pipeline, prompt contract, structured intent routing, citations, and application-enforced approval gates. Use when implementing or reviewing EXPLORE/PLAN travel assistants, prompt engineering, model response schemas, retrieval-augmented answers, create/modify-plan proposals, or migration from frontend keyword mocks to a backend AI endpoint.
---

# Build Travel AI QA

Turn a mock travel chatbot into a server-side, evidence-aware LLM workflow without allowing model output to mutate application data directly.

## Workflow

1. Read the product Issue and existing chat implementation. Identify intents, confirmation behavior, data shapes, and persistence boundaries.
2. Read [references/product-and-prompt-contract.md](references/product-and-prompt-contract.md). Preserve its precedence, intent, evidence, and approval rules unless the product Issue supersedes them. Reuse `scripts/travel-ai-contract.cjs` when the target project is this Demo so runtime Prompt and Schema do not drift from the skill.
3. Read [references/backend-contract.md](references/backend-contract.md) before changing API routes, secrets, retrieval adapters, timeouts, or error handling.
4. Implement the smallest vertical slice: browser request → backend orchestration → model JSON → validation → UI proposal → explicit confirmation.
5. Keep provider SDK code behind one adapter. Prefer the repository's configured provider; otherwise use a configurable OpenAI-compatible server-side adapter.
6. Validate every model response. Run `node scripts/validate-travel-response.mjs < response.json` or import its validator in tests.
7. Test intent conflicts, missing fields, fabricated citations, abnormal durations, provider failures, cancellation, and confirmation bypass attempts.

## Required Architecture

Use this sequence:

`normalize → classify/clarify → retrieve → synthesize → validate → return proposal → confirm in application → persist`

- Treat the model as a proposal generator, never as an executor.
- Execute create/modify/profile actions only in application code after a separate confirmation action.
- Keep API keys server-side. Never embed them in HTML, browser JavaScript, logs, or model-visible context.
- Send structured profile and current-plan data; do not concatenate untrusted fields into system instructions.
- Retrieve live facts before answering about prices, weather, hours, visas, routes, schedules, or current reviews.
- Cite only evidence supplied by retrieval. Label estimates and unavailable live data explicitly.
- Preserve fields the user did not ask to change when producing a modification patch.
- Degrade to clarification or a sourced partial answer on dependency failure; never invent missing data.

## Prompt Engineering Rules

- Separate stable policy, product context, retrieved evidence, conversation state, and latest request.
- Apply explicit current instructions before profile preferences.
- Ask only for missing information that materially changes the result.
- Require schema-constrained JSON at the provider boundary; do not parse prose with regex.
- Use low temperature for routing and schema generation.
- Include evidence IDs, retrieval timestamps, and supported-claim mapping.
- Reject unknown top-level keys and invalid intent/mode combinations.

## Delivery Checklist

- Add a server endpoint and provider adapter.
- Add request/response validation and bounded inputs.
- Add retrieval interfaces with deadlines, concurrency, deduplication, and provenance.
- Replace the frontend mock only after the backend response path works.
- Retain the confirmation UI; cancellation must perform no write.
- Add deterministic tests with mocked model and retrieval responses.
- Update environment examples and product limitations without committing secrets.

Do not claim a source is live or authoritative unless it was queried. Do not scrape restricted platforms without an approved, compliant source.
