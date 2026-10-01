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

1. The stack (`apps/local-agent/stack.ts`), in its own terminal:

   ```sh
   OPS_ENVIRONMENT=local OPS_LOCAL_AGENT_SEAT=hey OPS_LOCAL_AGENT_BUSINESS=alpha pnpm local-agent
   ```

   It makes a runner key, starts the runner, files the key for custody in
   `credentials.json` and writes `api.env`, both 0600 under
   `OPS_LOCAL_AGENT_HOME`. It prints the runner's origin and the `api.env` path,
   never the key. The home must be yours; it is made 0700.

   Each start makes a new key and a new port. After restarting the stack,
   source `api.env` again and restart the API and the tick: both load the key
   and the runner's origin once, at their own start, and every call fails
   until they do.

   With `OPS_LOCAL_AGENT_BUSINESS` set to a business `pnpm db:seed` made
   (`alpha` or `bravo`), it also writes the tick's identity into `api.env`: the
   business id, its agent's login subject (from `.local/synthetic-agents.json`)
   and an active worker actor, which the seed does not make, so the stack makes
   one, once (`apps/local-agent/seed.ts`). The database comes from
   `DATABASE_URL`/`DATABASE_ADMIN_URL` or `.local/db.env`, on this machine's
   loopback only (`DATABASE_NOT_LOCAL` otherwise). A business or agent the seed
   has not made refuses with `NOT_SEEDED` before anything is written.

2. The API, in a terminal that has run `source <home>/api.env` first. That file
   sets `OPS_ENVIRONMENT=local`, `OPS_AGENT_PROVIDER=local-claude` and the four
   `MODEL_BROKER_*` settings: the credentials file, the runner as destination
   `local_claude`, and one route `local_claude` (reach `local`, kind
   `subscription`). The side panel is then answered by the local session. It
   also names the runner's home, seat, and cap and usage file when set, for the
   tick's approval gate.

3. The tick (`apps/local-agent/tick-main.ts`), in a terminal that has also
   sourced `api.env` and exported `.local/db.env` for `DATABASE_URL`
   (`set -a; . .local/db.env; set +a`). The business, agent and worker come from
   `api.env` when the stack was started with `OPS_LOCAL_AGENT_BUSINESS`;
   otherwise set `OPS_LOCAL_AGENT_BUSINESS_ID`,
   `OPS_LOCAL_AGENT_AGENT_SUBJECT` and `OPS_LOCAL_AGENT_WORKER_ACTOR_ID`. Every
   `OPS_LOCAL_AGENT_TICK_SECONDS` (60 by default, 10 at least) it fires due
   schedules and runs queued task work, and prints counts and refusal codes,
   never the model's words.

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
- A cap set in `OPS_LOCAL_AGENT_CAP_USD` is the cap, whatever `approvals.json`
  says. Unset, the owner's yes on a raise is the cap from the next call on,
  never past USD 30.
- At the cap a call is refused before anything runs (`LOCAL_CAP_REACHED`). Any
  model but Haiku needs `approvals.json` `{ "models": [...] }`, else
  `LOCAL_MODEL_NOT_APPROVED`. The tick hands such work back and files one inbox
  decision item asking for the owner's yes, which it writes to `approvals.json`.
  A cap set in `OPS_LOCAL_AGENT_CAP_USD`, or one already at USD 30, is never
  asked about: a yes could not lift it, so the work is refused as it stands.
- Anyone the product lets decide the task can give that yes, not only the
  business's owner, and `approvals.json` belongs to the laptop: a yes in one
  business lifts the cap or allows the model for every business on that runner.
  Fine on made-up local data; settle it before anything wider.
- The yes does not re-run the refused work. It stays handed back failed; queue
  it again by hand.
- The yes is written to `approvals.json` under `approvals.json.lock`, taken
  before the tick picks the yes up. A tick that died holding it leaves the lock
  behind: each pass then picks no yes up, prints `refused APPROVALS_LOCKED`,
  and runs the rest of its queued work. The yeses stay queued until the lock is
  deleted by hand with no tick running. A yes picked up but not written is
  handed back failed, its summary naming `APPROVALS_UNWRITTEN` and the error code.
- One runner per home: a second one on the same ledger, or a second stack,
  refuses to start (`LOCAL_HOME_IN_USE`) before it writes a file. The seed's
  worker is found or made under a lock, so two starts on one business share one.

## What is not here

- A scheduled job fires and starts its run and task; its agent reply lands after
  AW-04 (SL11 U101), by the owner's ruling of 1 October 2026.
- A machine-readable seat usage reading; without the usage file, watching the 85%
  stop is the operator's job (`/usage`).
