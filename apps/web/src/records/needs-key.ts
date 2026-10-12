// SPDX-License-Identifier: AGPL-3.0-only
//
// The key a refused write needed, in one line: the key the refusal names, or
// else the one the command is declared with on the surface. The agent CLI's
// refusal line asks the same two questions here (`apps/cli/render.ts`).
//
// Only for the codes listed here, each one meaning "this reader does not hold
// the key". The list is closed on purpose: a code is added by name when it
// means that, never matched by a pattern over its spelling, because a code
// that merely contains a word like PERMIT (TRANSITION_NOT_PERMITTED, a
// blocking cycle) is about the record, and a writer told to get a key they
// already hold has been told the wrong remedy.

import { COMMAND_SURFACE } from '../../../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../../../packages/core-wire/src/index.ts';
import type { WireRefusal } from '../operations/client.ts';

const MISSING_KEY: ReadonlySet<string> = new Set(['SCOPE_NOT_GRANTED']);

/** The `collection:action` key `command` is declared with, or null for an unknown command. */
export function keyOf(command: CommandName): string | null {
  const row = COMMAND_SURFACE.find((one) => one.name === command);
  return row === undefined ? null : `${row.collection}:${row.action}`;
}

/** Whether a refusal `code` means the caller does not hold the key. */
export const missingKey = (code: string): boolean => MISSING_KEY.has(code);

/** The first `collection:action` key among a refusal's `names`, else `declared`. */
export function keyNamed(names: readonly unknown[], declared: string): string {
  const named = names.find((name) => typeof name === 'string' && /^[a-z_]+:[a-z_]+$/u.test(name));
  return typeof named === 'string' ? named : declared;
}

export function needsKey(command: CommandName, refusal: WireRefusal | undefined): string | null {
  const key = keyOf(command);
  return key !== null && refusal !== undefined && missingKey(refusal.code)
    ? `You need ${keyNamed(refusal.names, key)}.`
    : null;
}
