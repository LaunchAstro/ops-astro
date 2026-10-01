// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate before the first real client data and the first client invite.
//
// Built, and no longer held here: the readiness check and its refusals, the
// gate coverage and the mode (`s0-5-readiness.test.ts`, `s0-5-gate-decision.test.ts`,
// `s0-5-effect-classes.test.ts`), the gate's own commands with operator only,
// and the closing lines: the privacy opt-in, the Cloudflare credential rolled
// and the dated training line (`s0-5-gate-commands.test.ts`), and isolation
// (`s0-5-isolation.test.ts`). What is left waits on a migration for item 3's
// procedure line, the task share grant (MP-4-10, U15), staging or the owner's
// evidence; each says so.

import { it } from 'vitest';

it.todo(
  'MP-4-10 gate refusal: with the gate forced open, the share grant is refused in plain words and writes nothing (LEANS-ON SL08 MP-4-10)',
);
it.todo(
  "S0-5 share grant enrols no one: a share grant lets the client's existing person open the task and creates no invitation, login or person (LEANS-ON SL08 MP-4-10)",
);
it.todo(
  "S0-5 session gate: the gate stays shut until C58's session limit and revocation tests are green on staging (LEANS-ON staging)",
);
it.todo('S0-5 step-up sweep: the gate stays shut until the step-up sweep holds (LEANS-ON staging)');
it.todo(
  "S0-5 privacy procedure: item 3's tested manual privacy-request procedure has its evidence link, or the gate stays shut (LEANS-ON a migration: item 3 is one row with one link, so the procedure needs its own line in ops.gate_items and the readiness function; and on C81's backup leg, still held)",
);
it.todo(
  'S0-5 scan finding closure: every blocker and major is fixed; only a minor may be accepted, with its impact, a compensating control and an expiry (LEANS-ON staging)',
);
it.todo(
  "S0-5 phone alert delivered: a watched staging service stopped on purpose reaches the owner's subscribed phone (LEANS-ON staging and the owner's evidence)",
);
