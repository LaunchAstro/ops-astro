// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate before the first real client data and the first client invite.
//
// Built, and no longer held here: the readiness check and its refusals, the
// gate coverage and the mode (`s0-5-readiness.test.ts`, `s0-5-gate-decision.test.ts`,
// `s0-5-effect-classes.test.ts`), the gate's own commands with operator only,
// and the closing lines: the privacy opt-in, the Cloudflare credential rolled
// and the dated training line, and item 3's privacy-request procedure line
// (`s0-5-gate-commands.test.ts`), isolation (`s0-5-isolation.test.ts`) and the
// task share grant (MP-4-10, `s0-5-share-grant.test.ts`). The todos below are
// the union of the two lines' copies, so the isolation and share grant ones are
// held until the batch retires them. What is left waits on C81's backup leg,
// the backup restore (S0-3), staging or the owner's evidence; each says so.

import { it } from 'vitest';

it.todo(
  'S0-5 isolation: another business, and another client, is never read, listed, counted, exported or changed through the gate (LEANS-ON SL01 S0-3)',
);
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
  "S0-5 privacy procedure backup leg: the procedure's dry run finds the canary in a backup restored from before the erasure only in lawfully kept copies, or the gate stays shut (LEANS-ON C81's backup leg, held on SL01 S0-3 restore)",
);
it.todo(
  'S0-5 scan finding closure: every blocker and major is fixed; only a minor may be accepted, with its impact, a compensating control and an expiry (LEANS-ON staging)',
);
it.todo(
  "S0-5 phone alert delivered: a watched staging service stopped on purpose reaches the owner's subscribed phone (LEANS-ON staging and the owner's evidence)",
);
