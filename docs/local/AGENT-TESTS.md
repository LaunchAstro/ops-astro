# Agent tests

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The agent test harness (#1626 R11) runs a case set through the agent loop
(`core-agent`'s `runAttempt`) and writes a results file. Today it runs on the
replay fake only: every turn goes to the fake on loopback, with no database,
credential or other host, so a set gives the same results each run. Running
the sets on the owner's ChatGPT plan, and refusing unless the owner started
the run, is R12 (#1721).

## The sets

- `pnpm agent-tests:luna`: the basic checkable cases, written for GPT Luna. A
  named outcome, a tool the catalogue does not offer, the call limit, and the
  plan's allowance running out (the fake's 429, `LOCAL_PLAN_LIMIT`).
- `pnpm agent-tests:sol`: the harder cases, written for GPT Sol. The page with
  a hidden instruction, and the full draft of the correction.

The cases are in `apps/agent-tests/cases.ts`. A case passes when its attempt
ends in the code it expects and, when it finishes, its final answer holds what
it must and leaves out what it must not. A command exits 1 when a case fails.

## The results file

By default `agent-test-results/<set>-<time>.json` (not committed); `--out
<file>` names another. A run never writes over a results file already there,
so a saved review stays with the results it reviewed. It records the set, the model it is written for
(`target`), the provider, and for each case the model its answers named, its
outcome and end code, the code it expected, whether it passed, its turns and
its usage. The set's usage is the sum of its cases'.

## Astra's review

`pnpm agent-tests:review <results file> <review file>` saves the review beside
the results file as `<results>.astra-review.md`. It refuses, writing nothing,
when the first file is not a results file, and never writes over a review
already saved.
