# The local agent (GPT on the owner's laptop)

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The agent side panel answers from GPT through the owner's own ChatGPT plan,
by `codex exec` on the laptop (LA-1; owner, 7 October 2026). It runs only
where `OPS_ENVIRONMENT=local` and spends no money: the plan is already paid
for. Staging has no real model yet.

## Start it

1. Once: make the runner's home and sign its own Codex home in to ChatGPT.
   It is separate from your `~/.codex`, so your own instructions and memories
   never reach a call. The launcher makes nothing until that login is there:

   ```sh
   mkdir -p -m 700 ~/.ops-astro-local-agent ~/.ops-astro-local-agent/codex
   CODEX_HOME=~/.ops-astro-local-agent/codex codex login
   ```

2. Each time: `OPS_ENVIRONMENT=local pnpm local-agent`. It starts the runner
   on loopback, files the runner's key for custody (`credentials.json`, 0600)
   and writes `~/.ops-astro-local-agent/api.env` (0600). Each start picks a
   new port and key unless `OPS_LOCAL_AGENT_PORT` and `OPS_LOCAL_AGENT_KEY`
   are set.
3. In another terminal: `source ~/.ops-astro-local-agent/api.env`, then
   `pnpm api:up` and `pnpm web:up` as usual. The side panel now answers.
   The API reads the port and key only when it starts: after every launcher
   start, re-source `api.env` and restart the API.

## What it refuses

- Anywhere but `OPS_ENVIRONMENT=local`: the API refuses
  `OPS_AGENT_PROVIDER=local-gpt`, and the runner and launcher refuse to
  start (`LOCAL_ONLY`).
- A runner home someone else owns (`HOME_NOT_OWNED`) or that others can
  write to (`HOME_NOT_PRIVATE`; `chmod 700` it), a home or installation
  name holding a quote or line break, or a port that is not a port
  (`SETTING_MALFORMED`), and a second start while a runner holds the home
  (`LOCAL_HOME_IN_USE`).
- A runner home whose Codex login is not the ChatGPT plan: an API-key login
  would bill per call, so `pnpm local-agent` stops with `CODEX_NOT_SIGNED_IN`.
- **Chat about a client.** GPT is a cloud model, so the owner's rule on client
  material stands: a conversation opened on a client's task asks no model.
  Only your own typed message reaches GPT; task text and anything from outside
  the business (an enquiry, a guest) waits for a local model.
- Tools. Each call runs with every Codex tool off, a read-only sandbox, no
  saved session and a minimal environment; a reply in which the model reached
  for a tool is not used.

## The cap and approvals

Codex reports tokens, not dollars, so the cap counts tokens: 2,000,000 by
default. `~/.ops-astro-local-agent/ledger.jsonl` keeps one line per call. To
raise the cap (10,000,000 at most) or allow another model, write
`~/.ops-astro-local-agent/approvals.json` by hand:

```json
{ "capTokens": 4000000, "models": ["gpt-5"] }
```

`OPS_LOCAL_AGENT_CAP_TOKENS` set when starting is the cap; one above 2,000,000
starts only when `approvals.json` names that same figure (`CAP_NOT_APPROVED`).
When the plan itself is at its usage limit, the panel says so
(`LOCAL_PLAN_LIMIT`); wait for it to reset.

## Streamed answers

A call that asks to stream (`"stream": true`) runs `codex app-server` on
stdio instead of `codex exec`, which hands back only the finished message.
The child keeps every isolation above: the runner's empty folder and Codex
home, the minimal environment, every tool off, and a ChatGPT login only. A
Codex home holding a `config.toml` is refused, since the app-server has no
flag to skip it. The thread is ephemeral and read-only, and never asks for
approval. The runner answers as NDJSON: `{"sent": true}` once the turn is
started, a `{"piece": "…"}` line for each piece of the answer, then one
`{"answer": …}` line, the same body a whole answer has. Pieces are
provisional; the answer is what counts. The model's reasoning is never a
piece, and a tool, a request from the server or a message the runner does not
know stops the call unanswered.

Before any thread, a streamed call checks, and on any refusal asks the model
nothing and charges nothing:

- **The Codex it runs.** With `OPS_LOCAL_AGENT_CODEX_VERSION` set, the version
  the app-server reports must be that one, on the runner's own Codex home;
  otherwise `LOCAL_GPT_FAILED`.
- **The account.** It must be the ChatGPT plan's; signed out, or on an API
  key, is `GPT_SIGNED_OUT`. Sign the runner's Codex home in again.
- **The plan's week.** The account is shared with the reviewer, so the chat
  stops at 95% of the week (`GPT_WEEK_RESERVED`; the runner's log line gives
  the reset time). The plan must say outright that ordinary use may go on: a
  reading that does not, or has no weekly window, is `GPT_USAGE_UNKNOWN`; one
  that refuses it is `LOCAL_PLAN_LIMIT`. The 5-hour window is Codex's own stop.
- **The send deadline.** A call carrying `x-ops-send-by` (Unix milliseconds,
  from custody on the M5) never waits behind another call
  (`MODEL_MACHINE_BUSY`), and its turn is never started after that time
  (`SEND_LAPSED`): the prompt leaves the machine with the turn.

## On the M5

The runner also starts where `OPS_LOCAL_AGENT_SITE=m5`, with
`OPS_LOCAL_AGENT_CODEX_VERSION` pinned (`VERSION_UNPINNED` otherwise), and
never with `VERCEL` set (`HOSTED_REFUSED`). It still listens on loopback only.
Its Codex home is its own and signed in by device code
(`CODEX_HOME=<home>/codex codex login --device-auth`), never a copy of
another Codex home's login.
