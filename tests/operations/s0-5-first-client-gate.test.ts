// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate before the first real client data and the first client invite.
//
// Built, and no longer held here: the readiness check and its refusals, the
// gate coverage and the mode (`s0-5-readiness.test.ts`, `s0-5-gate-decision.test.ts`,
// `s0-5-effect-classes.test.ts`), the gate's own commands with operator only,
// and the closing lines: the privacy opt-in, the Cloudflare credential rolled
// and the dated training line (`s0-5-gate-commands.test.ts`), and the task
// share grant (MP-4-10, `s0-5-share-grant.test.ts`). What is left waits on the
// backup restore (S0-3), the agent route (S0-6), staging or the owner's
// evidence; each says so.

import { it } from 'vitest';

it.todo(
  'S0-5 isolation: another business, and another client, is never read, listed, counted, exported or changed through the gate (LEANS-ON SL01 S0-3)',
);
it.todo(
  "S0-5 session gate: the gate stays shut until C58's session limit and revocation tests are green on staging (LEANS-ON staging)",
);
it.todo('S0-5 step-up sweep: the gate stays shut until the step-up sweep holds (LEANS-ON staging)');
it.todo(
  "S0-5 privacy procedure: item 3's tested manual privacy-request procedure has its evidence link, or the gate stays shut (LEANS-ON SL01 S0-3)",
);
it.todo(
  'S0-5 scan finding closure: every blocker and major is fixed; only a minor may be accepted, with its impact, a compensating control and an expiry (LEANS-ON staging)',
);
it.todo(
  "S0-5 phone alert delivered: a watched staging service stopped on purpose reaches the owner's subscribed phone (LEANS-ON staging and the owner's evidence)",
);
