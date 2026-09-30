// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5's client lock, the legs not yet built, each titled with what it leans
// on. Held in a file of their own: db-conformance refuses a todo in a manifest
// suite. `s0-5-client-lock.test.ts` holds what is built.

import { it } from 'vitest';

it.todo(
  'S0-5 client change refused once the task has content: through the app and an agent credential, for every task-content kind (LEANS-ON SL01 S0-6)',
);
it.todo(
  "S0-5 content marker and lock order: the runtime's task-content commands (comment, propose, decide, pickup, handback, restore, cancel, restart, heartbeat, dispatch, observe, the budget acts, delegation.revoke) each write a history event on the task and a new revision under the task's row lock (NEXT: the runtime's lock order takes the task first)",
);
it.todo(
  "S0-5 content marker and lock order: the envelope derives the task's client and asks authority only under the task row lock; today it resolves the sign-in, reads the spine and asks authority first, each step named in s0-5-lock-order.test.ts, where a write or unnamed read before the lock already fails (NEXT: the runtime half, a design question)",
);
it.todo(
  "S0-5 client change refused once the task has content: the change first, a writer holding client A only is refused and one holding A and B writes under B (LEANS-ON task authority by the task's client: today a task command is authorised against the task or the whole business, never a client grant)",
);
