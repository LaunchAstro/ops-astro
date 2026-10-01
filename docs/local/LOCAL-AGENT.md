<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# The local agent: `local-claude` on the owner's laptop

LA-1 (roadmap issue 859). The agent features (the side panel, a task's agent
run, and scheduled jobs) can run against Claude Code on the owner's own
subscription instead of the paid API. It is for the owner's own tests on made-up
data. It never runs on staging, hosted or production, and it never serves a
client: client-facing agent work stays on the API.

`OPS_AGENT_PROVIDER` unset or `api` is the broker as AW-01 built it, unchanged.
`local-claude` is refused unless `OPS_ENVIRONMENT=local`.

## Start it

1. The runner (`apps/local-agent/main.ts`), in its own terminal:

   ```sh
   OPS_ENVIRONMENT=local \
   OPS_LOCAL_AGENT_SEAT=hey \
   OPS_LOCAL_AGENT_KEY=$(openssl rand -hex 24) \
   node apps/local-agent/main.ts
   ```

   It prints its loopback origin. Keep the key: custody needs the same value.

2. The API, with the broker pointed at the runner: `OPS_ENVIRONMENT=local`,
   `OPS_AGENT_PROVIDER=local-claude`, and the four `MODEL_BROKER_*` settings: a
   credentials file holding the runner key for destination `local_claude`, that
   destination's origin, one route `{ key: "local_claude", reach: "local",
provider: "local_claude", credentialKind: "subscription", ... }`, and the
   installation. `tests/local-agent/real-haiku.e2e.test.ts` builds exactly this.
3. The local tick (`apps/local-agent/tick.ts`) picks up queued task work and
   fires due schedules, as an interval in a long-lived process or once per call
   from the owner's crontab.

## What holds it

| Setting                           | Default                    | What it does                                                          |
| --------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| `OPS_LOCAL_AGENT_SEAT`            | none                       | `hey` or `nathan`; the seat's Claude Code login carries each call     |
| `OPS_LOCAL_AGENT_HOME`            | `~/.ops-astro-local-agent` | absolute path; holds the ledger, approvals and the runner lock        |
| `OPS_LOCAL_AGENT_CAP_USD`         | 10                         | API-equivalent cap; above 10 needs `approvals.json` `{ "capUsd": n }` |
| `OPS_LOCAL_AGENT_SEAT_USAGE_FILE` | none                       | optional `{ seat, percent, at }`; 85% or more refuses the call        |
| `OPS_LOCAL_AGENT_CLAUDE_BIN`      | `claude`                   | the binary; tests point it at a fake                                  |

- Every call is `claude -p --model haiku --output-format json` with no tools, no
  slash commands or skills, none of the seat's settings files, no auto memory, no
  session saved, an empty working folder and a budget of what is left under the
  cap.
- Each call adds a row to `ledger.jsonl` with Claude Code's reported cost. A call
  killed at its timeout is charged the whole budget it was given. An unreadable
  ledger counts as the cap, and a row that cannot be written stops every later
  call until the runner restarts.
- At the cap a call is refused before anything runs (`LOCAL_CAP_REACHED`) and the
  runner asks for the owner's yes. Any model but Haiku needs `approvals.json`
  `{ "models": [...] }`, else `LOCAL_MODEL_NOT_APPROVED`. Until the inbox approval
  gate is wired these are plain refusals.
- One runner per home: a second one on the same ledger refuses to start.

## What is not here

- A scheduled job fires and starts its run and task; its agent reply lands after
  AW-04 (SL11 U101), by the owner's ruling of 1 October 2026.
- The inbox decision item for raising the cap or approving another model.
- A machine-readable seat usage reading; without the usage file, watching the 85%
  stop is the operator's job (`/usage`).
