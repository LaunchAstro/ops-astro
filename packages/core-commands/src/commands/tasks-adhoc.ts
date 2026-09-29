// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.set_adhoc`: the Ad hoc mark (MP-4-10, CS-4.9).
//
// A task marked ad hoc drives billing and is the default for its new time
// entries (`adHocDefault` in `reads/tasks.ts`). The write is the owned-field
// write every owning operation shares, which refuses a field this command
// does not own and an unknown key. What it adds is the value: the mark is
// true or false. Null is refused rather than read as "clear", because an
// absent mark already reads as not ad hoc and a third state would be one
// billing has to guess at.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import type { FieldValues } from './requests.ts';
import { writeOwnedFields } from './tasks-state.ts';

/** The person entry's handler and the agent's (`agent-operations.ts`). */
export async function setAdHoc(
  tx: TenantQuery,
  context: Pick<CommandContext, 'spine' | 'target'>,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  if ('ad_hoc' in fields && typeof fields['ad_hoc'] !== 'boolean') {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['ad_hoc'], ['Send ad_hoc as true or false.']),
    );
  }
  return await writeOwnedFields(tx, context, 'task.set_adhoc', fields);
}
