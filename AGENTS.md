# AGENTS.md

Project conventions and hard-won knowledge for `pi-opencode-providers`, the pi extension that
serves **OpenCode Zen** and **OpenCode Go** under pi's own provider ids.

Read `CONVENTIONS.md` before any git or GitHub operation.

## Goal

Serve OpenCode Zen and Go under pi's own provider ids, matching what the OpenCode client currently does.

Criteria.

- Model data is read from the live catalog at runtime. Nothing about the model lineup is bundled in this repository.
- Routing, payload conversion and capability flags follow the rules the client applies.

## What this is

One extension, two providers (`opencode`, `opencode-go`), one console login. The catalog is the one
the OpenCode client reads, `https://models.opencode.ai` v2, plus the console V2 overlay; capability
flags come from the same catalog.

## Upstream sources

- The OpenCode client, `https://github.com/anomalyco/opencode`, branch `dev`. The earlier location at
  `sst/opencode` is not the reference; the repository moved to the `anomalyco` organization.
- The published docs, `https://opencode.ai/docs/`.
- Provider and catalog plugins live under `packages/core/src/plugin/`.
- `raw.githubusercontent.com` times out from some networks here. Fetch a file through
  `https://cdn.jsdelivr.net/gh/anomalyco/opencode@dev/<path>` when the raw host fails.

## Commands

```bash
bun install                  # dependencies
bun run typecheck            # tsc --noEmit (what CI runs)
bun test                     # unit tests
pi install .                 # install this checkout into pi
pi --list-models opencode-go # inspect the registered catalog
```

## Behaviour that cost time to establish

Dates below are when the observation was made; re-derive before trusting them.

- **OpenCode's catalog is the catalog; V2 is an overlay.** The base model list, each model's
  `api.<route>.sdk.aisdk`/`api.<route>.base_url` routing, limits and prices come from
  `https://models.opencode.ai/experimental/v2.0/api.json?type=chat,decision,image`, the endpoint the
  OpenCode client reads (`packages/core/src/models-dev.ts`). The path carries `experimental` because
  that contract is not frozen; the documented public API is still `models.dev/api.json`, whose default
  response omits the specialized model types and whose `?type=all` returns the same coverage in the
  v1 shape. `OPENCODE_MODELS_URL` selects a mirror; the v1 `/api.json` is read only when that origin
  answers 404 to the v2 path, and a v1 payload is converted before decoding (`isV1`/`toV2`), which is
  the client's own rule.
  `GET https://opencode.ai/console/api/v2/config` with `Authorization: Bearer <console token>` is
  a delta: it lists only the models the workspace disabled or changed, plus provider-level
  `canonical`/`package`/`settings.baseURL`. An empty `models` object means "no overrides", not "no
  models". Treating the overlay as complete wipes the Go list. Do not use the v1
  `/console/api/config` response.
- **Requests need a User-Agent.** The front door answers 403 (Cloudflare error 1010) to requests
  without one; any real identity passes. Do not drop the header when adding endpoints.
- **The V2 payload carries no reasoning flag.** Reasoning, attachment, tool support and thinking
  levels come from the catalog (`capabilities.reasoning` and its `effort` values, `capabilities.tools`).
  The same payload is the base model list; keep every active, text-capable entry and let the V2
  overlay remove or override entries. Do not filter the base list down to the ids the overlay mentions.
- **Three model types, one pi model type each.** `chat` maps to pi chat models, `decision` maps to
  pi classifier models on `typesafe-system-one`, and `image` is dropped. OpenCode keeps deprecated
  entries and marks them `enabled: false`; pi has no such field, so this extension drops them, along
  with chat entries whose tools are unsupported, rather than publishing something pi cannot run.
- **One catalog entry per provider id.** pi stores the catalog keyed by provider id, and those
  ids belong to pi's built-in providers too. pi republishes whatever `fetchModels` returns and
  drops any entry-level marker, so the extension marks each *model* (`piOpencodeCatalog`) and the
  failure path keeps only entries whose models carry that mark, or that lack `compat`/`inputLimits`
  (fields pi's built-in entries always have). Never serve the built-in list as a console result.
- **Auth is device flow only.** No key entry exists: neither provider declares an API key method, so
  pi's login list shows one account entry per provider and no key entry. Both provider ids carry the
  same device login; whichever one is used first writes the credential into the shared store, and the
  other one's login callback returns that credential unchanged, so it needs no second approval.
- **Per-provider request headers differ.** Go needs `x-opencode-session` on every request (a
  missing one answers `400 MissingSessionID`). Zen zero-cost models need the opencode identity
  set (versioned User-Agent, `x-opencode-client`, both session headers); paid Zen models carry
  neither. The session id sent must take the form that endpoint expects; that form is set in
  `src/request.ts`.
- **A rejected zero-cost call is not fixable here.** A 403 or 429 answers a limit this extension
  does not control, so fall back to paid Zen or Go rather than reshaping headers.
- **DeepSeek's thinking mode rejects a replayed turn without `reasoning_content`.** Each Go model is a
  different upstream, and DeepSeek is the one that answers `400 The reasoning_content in the thinking
  mode must be passed back`. pi fills that field only when the base URL names DeepSeek
  (`openai-completions.js`, `requiresReasoningContentOnAssistantMessages`), and the gateway URL does
  not, so the catalog declares the requirement on DeepSeek entries itself: `family` starting with
  `deepseek`, or the id containing it. The same entries set `thinkingFormat: "deepseek"`. Other Go
  models were not observed failing, so they keep an empty compat. Do not widen this to every
  reasoning model without a reproduced failure.
- **Go's catalog lives in the same payload.** The catalog lists the Go provider and its per-model
  routes (for example `qwen3.8-max` on the anthropic endpoint while `glm-5.3` uses
  openai-compatible). Filtering `deprecated` leaves 30 models on 2026-10-28, the same set the
  official docs show. The V2 overlay carries no Go entries, so the base list, not the overlay, must
  drive the catalog.
- **The gateway lists more Go ids than anyone serves as Go.** `https://opencode.ai/inference/go/v1/models`
  returns 38 on 2026-10-28, while the catalog and the docs both say 30. The eight extras
  (`glm-5.1`, `grok-4.6`, `kimi-k2.6`, `minimax-m2.5`, `minimax-m2.7`, `omen-alpha`, `qwen3.6-plus`,
  `qwen3.7-max`) are catalogued under `opencode` instead, and `grok-4.6` and `omen-alpha` answer on
  the Go endpoint with `billing_source: go`. Do not take that endpoint as the model list.

## Conventions

**Commit timing.** Commit when the task step you are on has its criteria met. Never commit code
that fails `bun run typecheck` or `bun test`. Ticking a checkbox in the task file means its
judgement line holds, not that work started.

**Commit messages.** English, descriptive, one motive per commit. Subject states the change; the
body explains why when it is not obvious. No conventional-commit prefixes.

**Secret boundaries.** Never print, commit or paste console tokens, pi credentials or extracted
API keys. Unit tests use stubs. Live probes may read a credential in memory and must not echo it;
the request headers they set must not be logged.

**Verification requirements.** Before committing: `bun run typecheck` and `bun test` pass.
Test files take the `.test.ts` suffix and live under `test/`.
