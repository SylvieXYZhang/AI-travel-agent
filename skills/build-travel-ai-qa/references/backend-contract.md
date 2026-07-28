# Backend Contract

## Endpoint

Implement `POST /api/ai/chat` with JSON only.

```json
{
  "message": "把当前京都行程改为 7 天",
  "conversation": [{"role": "user", "content": "..."}],
  "profile": {},
  "current_plan": {},
  "locale": "zh-CN",
  "timezone": "Asia/Shanghai"
}
```

Bound message length, conversation turns, object depth, and total body size. Derive authenticated ownership server-side; never trust client ownership fields.

Return the response contract from `product-and-prompt-contract.md`. Use 4xx for invalid input, 429 for throttling, and 5xx/503 for provider failures. Return a stable error code and safe user message, never provider traces or secrets.

## Orchestration

1. Validate and normalize the request.
2. Determine mode, intent, missing fields, and retrieval needs with a structured routing call or deterministic pre-router.
3. Build focused retrieval queries and run independent providers concurrently with deadlines.
4. Normalize evidence into one provenance schema; discard stale or invalid records.
5. Synthesize with stable policy, structured context, evidence, and a strict response schema.
6. Validate model JSON and cross-check every citation against supplied evidence IDs and URLs.
7. Force `requires_confirmation=true` for mutation intents regardless of model output.
8. Return a proposal. Apply it only through a separate authenticated confirmation action.

## Provider boundary

Expose a small interface:

```js
generateStructured({ system, input, schema, signal })
```

Configure the model with environment variables. Use request deadlines. Retry only transient idempotent failures with bounded backoff.

```text
LLM_API_KEY
LLM_MODEL
LLM_BASE_URL
LLM_TIMEOUT_MS
AI_MAX_BODY_BYTES
```

Never expose `LLM_API_KEY` to the browser. Redact authorization headers and profile data in logs.

## Retrieval adapters

- `searchTravelFeedback(query, signal)`
- `searchHotels(destination, dates, guests, signal)`
- `getRoute(origin, destination, waypoints, signal)`
- `getWeather(destination, dates, signal)`
- `getTravelRules(passport, destination, dates, signal)`

Return normalized evidence, not prompt prose. If no compliant provider exists, return unavailable status and disclose the limitation.

## Confirmation and persistence

Treat the proposal as untrusted. On confirmation:

1. Revalidate it against the domain schema.
2. Authorize the user against the target object.
3. Compare versions to prevent stale writes.
4. Apply only allowed patch fields.
5. Save actor, timestamp, before/after diff, and proposal ID.

Cancellation must perform no mutation.

## Minimum tests

- Pure destination input creates a new-plan proposal, not a current-plan modification.
- “一周可以去哪里” returns EXPLORE candidates without confirmation.
- Modification preserves unspecified fields and requires confirmation.
- Missing material constraints returns CLARIFY.
- Unknown citation IDs fail validation.
- Mutation confirmation false is overridden or rejected.
- Provider timeout returns a safe partial/unavailable response.
- Oversized input, malformed JSON, and prompt-injection text are handled safely.
