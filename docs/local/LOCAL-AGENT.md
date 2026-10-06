# The local agent (GPT on the owner's laptop)

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The agent side panel answers from GPT through the owner's own ChatGPT plan,
by `codex exec` on the laptop (LA-1; owner, 7 October 2026). It runs only
where `OPS_ENVIRONMENT=local` and spends no money: the plan is already paid
for. Staging has no real model yet.

## Start it

1. Once: sign the runner's own Codex home in to ChatGPT. It is separate from
   your `~/.codex`, so your own instructions and memories never reach a call:

   ```sh
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
