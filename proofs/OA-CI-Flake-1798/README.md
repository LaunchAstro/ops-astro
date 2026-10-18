# Loaded runs for #1798

A summary of the loaded runs of `tests/ci/agent-login-provider-phase-rejudges.test.ts` on the M5,
18 Oct 2026, for the done-when as amended on #1798. The raw logs stay outside the repository; the
pull request names where. The merge-group run is the CI half.

## How

- A copy of ops-astro at `56f6d797f6` on the M5 (18 cores), with its own Postgres container on
  CI's `postgres:17-alpine` digest.
- Each set was two rounds. Each round started 10 vitest processes of the file at once (the
  provider fixture has ten loopback ports) beside 18 `yes` CPU burners, and everything else the
  M5 was running. One process is one loaded run.
- Each process: `nice -n 5 node node_modules/vitest/vitest.mjs run <file>`. Burners:
  `nice -n 15 yes` for `diag-old-cause` and `proof-old`, `nice -n 5 yes` for every later set.

## Sets

| Set               | File run                                                                | Burners | Result        |
| ----------------- | ----------------------------------------------------------------------- | ------- | ------------- |
| `diag-old-cause`  | the base file, the race's `'finished'` result extended to print the run | nice 15 | 17 of 20 fail |
| `proof-old`       | the base file, unchanged                                                | nice 15 | 20 of 20 pass |
| `proof-old-b`     | the base file, unchanged                                                | nice 5  | 7 of 20 fail  |
| `proof-new-b`     | the fix before formatting, under another file name                      | nice 5  | 20 of 20 pass |
| `proof-new-c`     | the same                                                                | nice 5  | 20 of 20 pass |
| `proof-new-final` | the head file of a305f43851 at its own path                             | nice 5  | 20 of 20 pass |

- Head file SHA-256:
  `23231a4767a39b5aef2a0aa3debb9932a4fbf3179e409521da6da6759334ffbc`.
- Each failure in `proof-old-b` is the CI line:
  `the operator must actually wait on this database lock: expected 'finished' to be 'waiting'`.
- In all 17 failures of `diag-old-cause`, the run ended after the bearer's expiry with
  `refused: the sign-in did not verify: missing, forged or expired ... Nothing was done.`
