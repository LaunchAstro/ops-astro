// SPDX-License-Identifier: AGPL-3.0-only
//
// The writes an external party (R4) may reach, re-exported by `surface.ts`
// (moved whole to keep it under its line cap).

import type { CommandName } from './command-names.ts';

/**
 * The writes an external party (R4) may reach: a comment, only in the client audience; signing
 * out, which writes only the record that this person's session ended (C23); opening their
 * own inbox item; and their own preference rows, which every signed-in person writes
 * (`preference:write`, CAPABILITY-SLICES.md; ORCH50's ruling). `commands/prepare.ts` refuses
 * every other write to a person without a membership, and `session.capabilities` and
 * discovery read this same list.
 */
export const EXTERNAL_WRITES: readonly CommandName[] = [
  'task.comment',
  'session.end',
  'inbox.seen',
  'preference.save',
  'preference.dismiss_tip',
];

/** Whether a person of this standing may send this write: the envelope and discovery ask it. */
export const admitsSelfWrite = (member: boolean, command: CommandName): boolean =>
  member || EXTERNAL_WRITES.includes(command);
