# Traps

A trap records a demonstrated failure that lacks an executable check. Each
entry names the check that will replace it. Remove the entry once that check
lands; the executable check becomes the durable record.

An entry contains the date, observed failure, intended check and location,
and current status. If no executable check is possible, record the reason and
the bounded review procedure that covers it.

There are no active entries in this file. This is not a claim that the
repository has no defects or that all verification is complete.

The sentence above was written before the first entry and has not been changed,
because this file is append-only for docs lanes. The entries below are active.

## 2026-09-23: a pattern kill took down the shared API

- **Observed.** At 06:48 UTC on 23 September, one lane cleaned up its own API
  with `pkill -f apps/api/server.ts`. The pattern matched every process whose
  command line contained that path, so it also stopped the shared API on
  `127.0.0.1:8790` that the local demo was serving. The demo stayed down until
  the coordinator restarted that API about two minutes later. Several lanes
  run their own API from their own worktree on the same machine. Their
  command lines look alike and differ only in the checkout and the port.
- **Rule.** Stop only the exact PIDs you started. Record each PID when you
  start the process (`$!` after a backgrounded command, or `lsof -nP
-iTCP:<your port> -sTCP:LISTEN -t` on your own port). Before you stop it,
  check it is still yours: `lsof -a -p <pid> -d cwd -Fn` shows your checkout.
  Then `kill <pid>`. Never run `pkill`, `killall`, `pkill -f` or any other
  pattern-based kill, and never stop a listener on a port you did not start.
- **Intended check.** No executable check exists yet. A start script could
  write a PID file under `.local/` and pair it with a stop script that kills
  only that PID after checking its working directory. Until then, this is
  covered by review: a handback that stops processes names the PIDs it
  started and stopped.
- **Status.** Open. The rule is in [the local README](local/README.md#stopping-what-you-started).
