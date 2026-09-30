// SPDX-License-Identifier: AGPL-3.0-only
//
// The client's read names and the two types drawn from them. They live beside
// the typed client (`client.ts`), which re-exports them, so a caller keeps
// importing them from the client as before.

import type { CommandName } from '../../../../packages/core-wire/src/index.ts';

/**
 * The reads, named here as their own type.
 *
 * Every one of them is already a `CommandName`: `COMMAND_SURFACE` declares
 * them with `kind: 'read'`, and `OnSurface` below holds this list to the
 * surface's own names, so a misspelt or retired read fails to typecheck here.
 * What the surface's type cannot say is which names are reads, which is
 * why this list exists: `read()` takes only these and `mutate()` takes every
 * other name, and both derive their route through the one `pathOf`.
 *
 * It cannot drift from the server unnoticed: `tests/surfaces/read-names.test.ts`
 * holds that every name here is declared on `COMMAND_SURFACE` with
 * `kind: 'read'`, and that every read declared there is here. A name the server
 * declares as a write fails that case rather than reaching a route through the
 * wrong method. The names are an array and the union is read off it, so the
 * list the case walks is the list the type is made of rather than a copy of it
 * kept in step by hand.
 */
export const READ_NAMES = [
  'task.read',
  'task.board',
  'person.list',
  'team.list',
  'settings.read',
  'session.capabilities',
  // The last two reads, which the client reached only through `mutate()` and
  // so with an operation identity a read does not carry (SPEC-ADJUDICATE (b)).
  // The same permission applies as on the API and the command line: the
  // server's `reads/dispatch.ts` asks it, not this list.
  'task.queue',
  'preset.plan',
  // A task's runs and their progress events (T2a).
  'task.execution',
  // What an observed effect came from (T2c2); the task page draws it in T2g.
  'task.receipt',
  // Search over what the caller may read (C1); the ⌘K surface is C1b's.
  'task.search',
  // Who is signed in, for the person menu (C23).
  'session.person',
  // The caller's own preferences (MP-2-11a); MP-2-11 draws them.
  'preference.read',
  // The activity ledger (MP-8-4), a read from the day it was declared.
  'task.ledger',
  // Settings ▸ Access (C32), under `access:manage` on the server.
  'access.read',
  'client.list',
  // The operations view (C55), under `operations:read` on the server.
  'operations.read',
  // The breach drill's notices (C81), under `privacy:manage` on the server.
  'privacy.draft_breach_notices',
] as const;

/**
 * Holds `READ_NAMES` to the surface's own names: a name here that is not a
 * `CommandName` fails the constraint and `ReadName` does not typecheck. It is a
 * constraint rather than `satisfies` on the array because `isolatedDeclarations`
 * refuses an `as const satisfies` export without its type written out in full.
 */
type OnSurface<Names extends readonly CommandName[]> = Names;

export type ReadName = OnSurface<typeof READ_NAMES>[number];

/**
 * What `mutate()` takes: any surface name not known to be a read. A read
 * reached through `mutate()` would carry an operation identity it does not
 * take, so a name typed as a read is refused where it is written. A caller
 * holding a plain `CommandName` still compiles, because the tuple keeps the
 * check from distributing over the union; which half such a name is in is
 * something only the running caller knows.
 */
export type NotARead<Name extends CommandName> = [Name] extends [ReadName] ? never : Name;
