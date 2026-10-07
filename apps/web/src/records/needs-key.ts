// SPDX-License-Identifier: AGPL-3.0-only
//
// The key a refused write needed, in one line. A grant refusal does not name
// the key it looked for, so the page names the one the command is declared
// with on the surface, as the CLI's refusal line does (`apps/cli/render.ts`).
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

export function needsKey(command: CommandName, refusal: WireRefusal | undefined): string | null {
  const key = keyOf(command);
  return key !== null && refusal !== undefined && MISSING_KEY.has(refusal.code)
    ? `You need ${key}.`
    : null;
}
