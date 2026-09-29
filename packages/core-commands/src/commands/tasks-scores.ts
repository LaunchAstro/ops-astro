// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.set_scores`: the three marks the derived rank reads (MP-4-9, R70).
//
// The write is the owned-field write every owning operation shares, which
// already refuses a field this command does not own, a value of the wrong type
// and an unknown key. What it adds is the range: a mark is a whole number from
// 1 to 10, or null to clear it, because absent is never 0. The database holds
// the same rule (0032); refusing here first answers by name instead of as a
// fault from the constraint.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import type { FieldValues } from './requests.ts';
import { writeOwnedFields } from './tasks-state.ts';

const MARKS: readonly string[] = ['confidence', 'ease', 'impact'];

function isMark(value: unknown): boolean {
  return typeof value !== 'number' || (Number.isInteger(value) && value >= 1 && value <= 10);
}

/**
 * The person entry's handler and the agent's (`agent-operations.ts`). Each
 * entry has locked the task, compared its revision and parsed `fields` as a
 * map. A value that is not a number is the owned write's type check to refuse.
 */
export async function setScores(
  tx: TenantQuery,
  context: Pick<CommandContext, 'spine' | 'target'>,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  const outside = MARKS.filter((key) => key in fields && !isMark(fields[key]));
  if (outside.length > 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', outside, [
        'A mark is a whole number from 1 to 10, or null to clear it.',
      ]),
    );
  }
  return await writeOwnedFields(tx, context, 'task.set_scores', fields);
}
