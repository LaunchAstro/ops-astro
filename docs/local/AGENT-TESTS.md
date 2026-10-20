# Agent tests

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The agent test harness (#1626 R11, R12) runs a case set through the agent
loop (`core-agent`'s `runAttempt`) and writes a results file. By default it
runs on the replay fake: every turn goes to the fake on loopback, with no
database, credential or other host, so a set gives the same results each run.
With `--plan` it runs on the owner's ChatGPT plan, on the M5, only when the
owner started it (below).

## The sets

- `pnpm agent-tests:luna`: the basic checkable cases, written for GPT Luna. A
  named outcome, a tool the catalogue does not offer, the call limit, and the
  plan's allowance running out (the fake's 429, `LOCAL_PLAN_LIMIT`).
- `pnpm agent-tests:sol`: the harder cases, written for GPT Sol. The page with
  a hidden instruction, and the full draft of the correction.

The cases are in `apps/agent-tests/cases.ts`. A case passes when its attempt
ends in the code it expects and, when it finishes, its final answer holds what
it must and leaves out what it must not. A command exits 1 when a case fails.

## On the owner's plan

Only the owner starts a run on the plan, on the M5, after the plan's sign-in
([chatgpt-plan.md](chatgpt-plan.md)). No agent writes the start line or runs
these commands, and CI never does: with `CI` or `GITHUB_ACTIONS` set, the
command refuses.

1. Write the start line, naming the set and today's date on the M5:

   ```sh
   printf '{"set":"luna","date":"%s"}\n' "$(date +%F)" > ~/.ops-astro/agent-tests-start.json
   chmod 600 ~/.ops-astro/agent-tests-start.json
   ```

2. From the ops-astro checkout on the M5, run `pnpm agent-tests:luna --plan`
   (or `sol`, with a start line for `sol`).

The command refuses, exit 2, and writes and sends nothing, without a start
line, with one for another set or another day, with anything more in it,
when it is a link, or when anyone else can read it. A line that fits is used
once: the run removes it before it starts, so each run needs a new one.

Each turn goes to custody, which holds the plan's token and presents it to
`https://api.openai.com`. The harness never opens the token file. The Luna
set runs on `gpt-6.1-luna` and the Sol set on `gpt-6.1-sol`, offering
`task.read` only. Cases whose fake replies break a rule or fault on cue (an
uncatalogued tool, the call limit, the allowance running out) are left out on
the plan. The plan's usage limit ends a case `LOCAL_PLAN_LIMIT`, waiting on the
plan's allowance; with the plan not signed in, each case ends
`CUSTODY_NOT_ADMITTED` and nothing is sent.

## The results file

By default `agent-test-results/<set>-<time>.json` (not committed); `--out
<file>` names another. A run never writes over a results file already there,
so a saved review stays with the results it reviewed. It records the set, the model it is written for
(`target`), the provider (`replay` or `chatgpt_plan`), and for each case the model its answers named, its
outcome and end code, the code it expected, whether it passed, its turns and
its usage. The set's usage is the sum of its cases'.

## Astra's review

`pnpm agent-tests:review <results file> <review file>` saves the review beside
the results file as `<results>.astra-review.md`. It refuses, writing nothing,
when the first file is not a results file, and never writes over a review
already saved.
