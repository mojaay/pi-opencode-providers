# Conventions

Rules for every agent working in `pi-opencode-providers`. Read this before changing code,
committing, or reviewing.

## Always green, shift left

A defect costs about 1 unit to fix at the spec, 10 at review, 100 in production. The gates keep the
cost near 1.

- **Preflight:** `bun run typecheck && bun test`.
- **Green:** exit 0, no skipped tests, no new warnings.
- **CI:** `gh pr checks` when a pull request is open.
- NEVER proceed on a red Preflight or red CI.

## Discovered defects

- Fix a data-only defect with `quick-fix`.
- Fix anything carrying logic risk through `fix-bug`: investigate, write a failing test, then fix.
- Give a discovered fix its own commit.

## Banned phrases

| Phrase | Why it is banned |
| --- | --- |
| pre-existing | The gate is red now. Attribution does not clear it. |
| unrelated to this session | The gate has no notion of sessions. |
| not introduced by my changes | Ownership is irrelevant to a red gate. |
| out of scope | Scope is set before work, not used to excuse a failure. |

## Commands

| Action | Command |
| --- | --- |
| Install | `bun install` |
| Test | `bun test` |
| Typecheck | `bun run typecheck` |
| Preflight | `bun run typecheck && bun test` |
| Install into pi | `pi install .` |
| Inspect the catalog | `pi --list-models opencode-go --offline` |

## Defensive code

The extension answers provider requests inside pi's process.

- **Timeout:** requests carry the AbortSignal their caller supplies. There is no built-in numeric
  deadline, so a new endpoint MUST accept and forward the signal.
- **Retry:** only the device-code request retries, and only for `DeviceAuthFailed`. Do not add silent
  retries elsewhere; a retried write is a duplicate request to a console API.
- **Rate limit:** no dedicated handling. A 429 surfaces as a request error and MUST NOT be
  swallowed into an empty catalog.
- **Circuit breaker:** not applicable, there is no long-lived connection pool.
- **Graceful degradation:** required. A catalog or usage failure MUST leave the previous state or an
  explicit "no data" marker. It MUST NOT empty the provider list or report zero usage.

## Secret boundaries

- Never print, commit or paste console tokens, pi credentials or extracted API keys.
- Unit tests use stubs and never read `~/.pi/agent/auth.json`.
- A live probe reads a credential in memory only. It MUST NOT echo the credential or log the request
  headers that carry it.

## Commit rules

- Write commit messages in English, one motive per commit.
- State the change in the subject and the reason in the body.
- Use no conventional-commit prefixes in this repository.
- Do not rewrite history that has been shared. Undo a change with `git revert`, or amend while the
  commit is unpushed and no one else has it.
- NEVER commit a red Preflight.
