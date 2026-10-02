// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.set_category`: the task's work label (MP-4-8, CS-4.16, DP-23).
//
// The write is the owned-field write every owning operation shares, which
// refuses a field this command does not own, an unknown key and an empty
// body. What it adds is the value: one of the nine ids of `TASK_CATEGORIES`,
// or null, which clears the label. Anything else, a label in place of its id
// included, is refused naming `category` before anything is written, so the
// board and the panel never meet a stored value they did not offer.
//
// A category is a label and nothing more (R76): this command writes the one
// field and reaches no grant, delegation or scope, and a body naming `agent`
// or any other field is refused whole by the owned-field write.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { TASK_CATEGORIES } from '../../../core-wire/src/index.ts';
import { refuseCommand } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import type { FieldValues } from './requests.ts';
import { writeOwnedFields, type FieldWriteContext } from './tasks-state.ts';

const CATEGORY_FIXES: readonly string[] = [
  `Send category as one of ${TASK_CATEGORIES.list()
    .map((one) => one.id)
    .join(', ')}, or null to clear it.`,
];

/** The person entry's handler and the agent's (`agent-operations.ts`). */
export async function setCategory(
  tx: TenantQuery,
  context: FieldWriteContext,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  if (
    'category' in fields &&
    fields['category'] !== null &&
    !TASK_CATEGORIES.has(fields['category'])
  ) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['category'], CATEGORY_FIXES));
  }
  return await writeOwnedFields(tx, context, 'task.set_category', fields);
}
