// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5's not-content rows for setup's commands (clients, custody keys and
// standing mandates), moved from `s0-5-client-lock-world.ts` to keep that
// file under the per-file line cap: each writes a client-scoped kind but is
// not content on an existing task.

export const SETUP_NOT_CONTENT: Readonly<Record<string, string>> = {
  'client.create': 'writes a client, not a task',
  'client.set_privacy': "a client's privacy settings, not a task",
  'secret.set': 'a key held for a client or the business, not a task (C31)',
  // MP-14-10a: a client's standing mandates and graduation rows, not a task.
  'mandate.file': "a client's standing mandate, not a task",
  'mandate.revoke': "a client's standing mandate, not a task",
  'graduation.promote': "a client's graduation row and mandate, not a task",
  'graduation.demote': "a client's graduation row and mandate, not a task",
};
