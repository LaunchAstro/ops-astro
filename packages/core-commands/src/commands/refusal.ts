// SPDX-License-Identifier: AGPL-3.0-only
//
// The translation from a refusal to what a caller is shown.
//
// Every layer returns the register's one `CommandRefusal`
// (`core-records/src/register.ts`), so nothing here converts between shapes;
// the type, its constructor and its discriminant are re-exported for the
// command layer's own callers.
//
// The translation is the part with teeth. `asCallerVisible` is the only way a
// refusal leaves a command, and an audit-only code does not survive it: the
// register says `WRONG_BUSINESS` is recorded and never returned, so this turns
// it into the same `NOT_FOUND` a fabricated identifier gets — same code, same
// empty names, same fixes. Anything else is an inference channel, which is the
// leak composite tenant keys exist to close (ADR 0014:14).

import {
  CALLER_VISIBLE,
  isCommandRefusal,
  refuseCommand,
  type CommandRefusal,
} from '../../../core-records/src/index.ts';

export { isCommandRefusal, refuseCommand, type CommandRefusal };

const NOT_FOUND_FIXES: readonly string[] = [
  'Check the identifier against the one you were given.',
  'If you believe it exists, ask someone who can already see it to share it with you.',
];

/**
 * What a caller may be shown. An audit-only code becomes the answer a caller
 * would have got had the record never existed, with nothing left of the
 * original — the names go too, because a name is the inference.
 */
export function asCallerVisible(refusal: CommandRefusal): CommandRefusal {
  if (CALLER_VISIBLE.has(refusal.code)) return refusal;
  return refuseNotFound();
}

/** The refusal a caller gets for a record that is not there, whatever the reason. */
export function refuseNotFound(): CommandRefusal {
  return refuseCommand('NOT_FOUND', [], NOT_FOUND_FIXES);
}
