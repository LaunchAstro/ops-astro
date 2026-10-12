// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.move`'s two operands, typed before the move reads them. Its operand
// table leaves both as `any`, so the move answers a wrong type in the field's
// own words, but the move compares boards as strings before it reaches that
// check, and a number or an object there was a fault, not a refusal. Split
// from `handlers.ts` to keep that file under the line limit.

import { readFieldDefinitions, type TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refused, type Refused } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import { refuseWrongValueType } from './values.ts';

const isIdOrNull = (value: unknown): boolean => value === null || typeof value === 'string';

/**
 * The refusal for a board or board section that is neither an identifier nor
 * null, as `FIELD_VALUE_INVALID` names it on every other field write, or
 * `undefined` when both are one or the other.
 */
export async function refuseMistypedPlacement(
  tx: TenantQuery,
  context: CommandContext,
  board: unknown,
  boardSection: unknown,
): Promise<Refused | undefined> {
  if (isIdOrNull(board) && isIdOrNull(boardSection)) return undefined;
  const definitions = await readFieldDefinitions(tx, context.spine.taskTypeId);
  const placement = { board, board_section: boardSection };
  return refused(
    refuseWrongValueType(definitions, placement) ??
      refuseCommand(
        'FIELD_VALUE_INVALID',
        Object.entries(placement)
          .filter(([, value]) => !isIdOrNull(value))
          .map(([key]) => key),
        ['Send board and boardSection each as a record identifier or null.'],
      ),
  );
}
