// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate before the first real client data and the first client invite.
//
// The readiness check is read by every command the command catalogue classes
// `client-data` or `invitation`. The classes are built, from each command's
// effect metadata (`s0-5-effect-classes.test.ts`, `s0-5-effect-metadata.test.ts`);
// the cases marked NEXT wait only on the readiness check itself, S0-5's next
// increment. S0-5 also waits on the backup restore (S0-3), the task share
// grant (MP-4-10, U15) and the agent route (S0-6), none on this branch.
// Several close only on the owner's evidence or on staging; those say so.

import { it } from 'vitest';

it.todo(
  'S0-5 gate refusals: with each of the eight items forced open in turn, every client-data and invitation command is refused in plain words and writes nothing, a seeded stand-in of each class included (NEXT: the readiness check)',
);
it.todo(
  'S0-5 gate coverage (gate forced open): every client-data and invitation command in the catalogue is refused and writes nothing; its metadata half is built (NEXT: the readiness check)',
);
it.todo(
  'S0-5 isolation: another business, and another client, is never read, listed, counted, exported or changed through the gate (LEANS-ON SL01 S0-3)',
);
it.todo(
  'S0-5 operator only: ticking an item, accepting a finding or changing the mode by an agent credential, under a delegation, or without operations:manage is refused and writes nothing (LEANS-ON SL01 S0-6)',
);
it.todo(
  'S0-5 mode one way: the mode changes only from made-up data to real data, by the owner, while the readiness check is true, and never back (NEXT: the readiness check)',
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
  "S0-5 privacy procedure: item 3's tested manual privacy-request procedure has its evidence link, or the gate stays shut (LEANS-ON SL01 S0-3)",
);
it.todo(
  "S0-5 privacy opt-in: only a link to the public register entry, with the owner confirming the policy matches it, closes the item (LEANS-ON the owner's evidence)",
);
it.todo(
  'S0-5 scan finding closure: every blocker and major is fixed; only a minor may be accepted, with its impact, a compensating control and an expiry (LEANS-ON staging)',
);
it.todo(
  "S0-5 Cloudflare credential rolled: the old credential is refused and the new one is in custody, or the gate stays shut (LEANS-ON the owner's evidence)",
);
it.todo(
  "S0-5 phone alert delivered: a watched staging service stopped on purpose reaches the owner's subscribed phone (LEANS-ON staging and the owner's evidence)",
);
