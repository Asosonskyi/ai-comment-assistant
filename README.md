# AI Comment Assistant

A Node/TypeScript (Fastify) server that finds social media posts matching a product's request and drafts helpful replies that mention the product. Every reply is approved by a human in Telegram before it is posted. Threads is the first platform.

POC status: all state is **in memory**, and runs are started manually over HTTP.

## Pipeline

```
POST /products/:id/run
  1 intake (products/*.json) → 2 query planner (LLM) → 3 discovery (platform search)
  → 4 filter (rules) & rank (LLM) → 5 draft (LLM + thread context) → 6 safety checks
  → 7 Telegram approval: Approve | Edit | Redraft (with feedback) | Reject
  → 8 publish queue (paced, capped) → platform → reply log
```

| Module | Code | Swap by |
| --- | --- | --- |
| 1. Request intake | `src/config/` + `products/*.json` | adding a JSON file |
| 2. Query planner | `src/modules/queryPlanner.ts` | `llm.queryPlanner` in config, or `useQueryPlanner: false` |
| 3. Discovery | `src/modules/discovery.ts` → `PlatformAdapter.search` | `platform.name` |
| 4. Filter & rank | `src/modules/filterRank.ts` | `filters` and `llm.rank` |
| 5. Draft | `src/modules/drafter.ts`, `src/prompts/draft.ts` | `llm.draft`, `tone`, `language` |
| 6. Safety | `src/modules/safety.ts` | `replyPolicy`, `llm.moderate` |
| 7. Approval | `src/approval/telegram.ts`, `src/core/approvalActions.ts` | `approval.channel` |
| 8. Publish & log | `src/core/publishQueue.ts`, `src/modules/publisher.ts` | `replyPolicy` pacing and caps |

Only the `PlatformAdapter` talks to a social network, only the `LlmProvider` talks to an LLM, and only the `ApprovalChannel` talks to approvers. `src/core/registry.ts` maps the config names (`threads`, `anthropic`, `openai`, `telegram`) to their implementations, and `src/index.ts` registers them.

## Setup

1. **Install:** `pnpm install`, then `cp .env.example .env`.
2. **Tunnel:** start ngrok or Cloudflare Tunnel on a *stable* domain pointing at `PORT` (for example `ngrok http --url=<your-static-domain> 3000`), and set `PUBLIC_BASE_URL` to that domain. Meta needs a fixed redirect URI.
3. **Meta app:** create an app with the Threads use case.
   - Add the Yollly Threads account as a **Threads tester** and accept the invite in Threads (Settings → Account → Website permissions).
   - Add these permissions: `threads_basic`, `threads_content_publish`, `threads_keyword_search`, `threads_read_replies`, `threads_manage_replies`.
   - Set the redirect callback URL to `${PUBLIC_BASE_URL}/auth/threads/callback`, the uninstall URL to `${PUBLIC_BASE_URL}/auth/threads/uninstall`, and the delete URL to `${PUBLIC_BASE_URL}/auth/threads/delete`.
   - Copy the Threads app id and secret into `THREADS_APP_ID` and `THREADS_APP_SECRET`.
   - **Start App Review for `threads_keyword_search`** (plus the reply scopes) now: it takes 3–6 weeks, and until it is approved keyword search only returns your own posts.
4. **Telegram:** create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. Start the server, send `/chatid` to the bot (or in the group you want to use), then put your user id in `TELEGRAM_ALLOWED_USER_IDS` and the chat id in `approval.chatId` in `products/yollly.json`. Restart the server.
5. **LLM:** set `ANTHROPIC_API_KEY` (the default provider). Set `OPENAI_API_KEY` only if a product config uses `"provider": "openai"`.
6. **Run:** `pnpm dev` (watch mode) or `pnpm start`.
7. **Connect Threads:** open `${PUBLIC_BASE_URL}/auth/threads/yollly?key=<ADMIN_API_KEY>`, log in as Yollly, and wait for the confirmation in Telegram. Tokens live in memory, so after a restart either log in again or set `THREADS_TOKEN_YOLLLY` as a fallback.

## Using it

All endpoints need the `x-api-key: <ADMIN_API_KEY>` header.

```bash
curl -H "x-api-key: $KEY" localhost:3000/health                      # connection, token expiry, paused, queue
curl -H "x-api-key: $KEY" -X POST localhost:3000/products/yollly/run # → {"runId": "..."}
curl -H "x-api-key: $KEY" localhost:3000/runs/<runId>                # queries, counts, blocked reasons, errors
curl -H "x-api-key: $KEY" localhost:3000/products/yollly/replies     # reply log (since boot + recovered)
curl -H "x-api-key: $KEY" -X POST localhost:3000/products/yollly/pause
curl -H "x-api-key: $KEY" -X POST localhost:3000/products/yollly/resume
```

Runs can also be started from Telegram with `/run` (or `/run yollly` when several products are configured); only users in `TELEGRAM_ALLOWED_USER_IDS` can use it, and it has the same preconditions as `POST /products/:id/run`.

Drafts arrive in Telegram as cards with buttons:

- **Approve** queues the draft for publishing.
- **Edit** asks for replacement text, re-runs the safety checks, then queues it.
- **Redraft** asks for feedback and sends a new card.
- **Reject** drops the draft.

**Testing before App Review:** `products/yollly.json` sets `"includeOwnPosts": true`, so posts written by the Yollly account itself can be found and replied to. Write 2–3 test posts from Yollly (for example "any quick breakfast ideas? bored of toast"), then start a run. Set it back to `false` once keyword search is approved.

## Adding a product

Copy `products/yollly.json` to `products/<id>.json`, change the fields, and restart. Nothing else is needed. The config is validated at boot, and a bad file stops the server with an error that names it. Key fields:

| Field | Meaning |
| --- | --- |
| `pitch` | What the product does; the drafter and moderator only allow claims made here |
| `discovery.topicDescription`, `keywords`, `tags` | What conversations to find; the query planner adds more queries up to `maxQueries` |
| `discovery.searchType`, `sinceHours` | `RECENT` + last N hours for live conversations |
| `filters.minRelevance`, `maxDraftsPerRun` | Ranking threshold and the number of drafts per run |
| `replyPolicy` | `allowLinks` (default false), `maxChars`, `dailyCap`, `minGapMinutes` + `jitterMinutes`, `bannedPhrases`, `maxSimilarity` |
| `llm` | `default` plus optional per-stage overrides: `queryPlanner`, `rank`, `draft`, `moderate` (`provider`, `model`, `effort`) |
| `approval.chatId` | Telegram chat that receives the draft cards |

## Adding a platform

1. Implement `PlatformAdapter` (`src/platforms/PlatformAdapter.ts`): `search`, `getThreadContext`, `publishReply`, `getReplyQuota`, `listOwnReplies` and `whoAmI`. Map the platform's errors to `PlatformError` kinds; `rate_limited`, `restricted`, `permission` and `auth` auto-pause the product.
2. Register it in `src/index.ts` (`{ threads: ..., yourplatform: ... }`) and add its auth flow.
3. Check the platform's automation rules first. X, for example, forbids keyword-triggered auto-replies.

## Anti-ban safeguards

- A human approves every reply.
- No links by default, no hashtags or @mentions, and the product is mentioned by name only, speaking as the brand.
- Rule checks and an LLM moderation pass run on every draft, including human edits.
- Near-duplicates are blocked: a reply cannot be too similar (trigram) to any of the last 50 replies.
- At most one reply per conversation.
- Pacing: replies are published one at a time per account, `minGapMinutes` plus random jitter apart.
- Daily cap per product, which also respects Threads' own reply quota (`threads_publishing_limit`).
- Auto-pause, with a Telegram alert, on rate-limit, restriction or permission errors.
- After a restart, the account's own replies from the last 7 days are reloaded from Threads, so dedupe, caps and pacing survive.

## Known POC limits

- In-memory state: runs, seen posts, pending Telegram approvals and OAuth tokens are lost on restart. Reply history is recovered from Threads; Telegram buttons on old cards answer "draft expired".
- Runs are manual; there is no scheduler yet.
- Threads webhooks (mentions) are not used yet.

## Development

```bash
pnpm typecheck
pnpm test
```
