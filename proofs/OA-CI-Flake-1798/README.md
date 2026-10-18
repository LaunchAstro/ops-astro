# Loaded runs for #1798

Raw logs of `tests/ci/agent-login-provider-phase-rejudges.test.ts` under load on the M5, 18 Oct
2026, for the done-when as amended on #1798. The merge-group run is the CI half.

## Where and how

- A copy of ops-astro at `56f6d797f6` in `~/m5lanes/oa-ci-flake` on the M5 (18 cores), with its
  own Postgres container on CI's `postgres:17-alpine` digest at `127.0.0.1:54798`.
- [`loaded-runs.sh`](loaded-runs.sh) is the harness. Each round starts 10 vitest processes of the
  file at once (the provider fixture has ten loopback ports, so ten is the most at once) beside 18
  `yes` CPU burners, and everything else the M5 was running. One process is one loaded run. Each
  set writes one log per run, `r<round>-c<copy>.log`, and a `summary.log`.
- Every set was run as `zsh ~/m5lanes/oa-ci-flake-loaded-runs.sh <set> 2 10 <file> 18`.
- The logs are as vitest wrote them, with one change: the M5's home directory is written `~`,
  because the repository's commit gate refuses home directory paths.

## The sets

| Set               | File run                                                                                | Burners | Result        |
| ----------------- | --------------------------------------------------------------------------------------- | ------- | ------------- |
| `proof-old`       | the base file, unchanged                                                                | nice 15 | 20 of 20 pass |
| `proof-old-b`     | the base file, unchanged                                                                | nice 5  | 7 of 20 fail  |
| `proof-new-b`     | the fix before formatting, as `tests/ci/new-rejudges.test.ts`                           | nice 5  | 20 of 20 pass |
| `proof-new-c`     | the same                                                                                | nice 5  | 20 of 20 pass |
| `proof-new-final` | the head file of a305f43851 at its own path (sha256 `23231a47...ffbc`)                  | nice 5  | 20 of 20 pass |
| `diag-old-cause`  | the base file with the race's `'finished'` result extended to print the run's own lines | nice 15 | 17 of 20 fail |

- `diag-old-cause` (its summary says `diag-b`), then `proof-old`, ran before the harness's
  burners moved from nice 15 to nice 5. The load from the M5's other work varied between sets: at
  nice 15 `diag-old-cause` failed 17 of 20 and `proof-old` passed 20 of 20, so the burners went to
  nice 5. `loaded-runs.sh` here is the nice 5 version, which every later set used.
- Each failure in `proof-old-b` is the CI line:
  `the operator must actually wait on this database lock: expected 'finished' to be 'waiting'`.
- `diag-old-cause` shows why. In all 17 failures, the run ended after the bearer's expiry with
  `refused: the sign-in did not verify: missing, forged or expired ... Nothing was done.`
