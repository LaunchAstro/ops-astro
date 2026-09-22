// SPDX-License-Identifier: AGPL-3.0-only
//
// The commands that own a field.
//
// Ten operations are named as owners on the task type's own field definitions
// and minimum contract 5.3's fourth assertion requires each of them to exist
// and be reachable — "a protected field whose owning operation does not exist
// is a field nobody can change". Rather than ten hand-written commands, there
// are two shapes here, because the data already says which fields each one
// owns:
//
// - `setState` for the three that move the lifecycle. They take **no field
//   values**: the state is derived from the machine category the command
//   means, so `state` never appears in a payload on any surface and the
//   completion stamp cannot be set apart from the transition that earns it.
// - `writeOwnedFields` for the five that write ordinary values a person
//   chooses — the assignee, the intake decision, the stage, the party, the
//   disclosure flag. Which keys each may write is read from
//   `field_defs.owning_operation` at call time, so adding a protected field to
//   the spine gives its owning operation the right to write it without a line
//   of code here.
//
// The refusal for a key the invoked command does not own names the command
// that does, and for a generic field that command is `task.update`. Every
// field on the type has exactly one command that may write it, and this is
// where that sentence is enforced from both sides.

import type { TenantQuery } from '../tenancy/database.ts';
import { readFieldDefinitions } from '../records/field-store.ts';
import { isLive, type FieldDefinition } from '../records/fields.ts';
import { isRecordsRefusal } from '../records/refusals.ts';
import { mergeFieldValues } from '../tasks/placement.ts';
import { setTaskState } from '../tasks/state.ts';
import type { MachineCategory } from '../tasks/states.ts';
import { fromRecords, refuseCommand } from './refusal.ts';
import { refuseWrongValueType } from './values.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import type { CommandName } from './surface.ts';
import type { FieldValues } from './requests.ts';

/** The one command that may write a field, from the field's own row. */
function writerOf(field: FieldDefinition): readonly string[] {
  if (field.writeMode === 'system') return [];
  if (field.owningOperation === null) return ['task.update'];
  return field.owningOperation.split(' ');
}

/**
 * Move the lifecycle, and let the stamp follow.
 *
 * The state is chosen by machine category rather than by key, because the five
 * words an installation seeds are preset data and a command may not depend on
 * one of them being present (specification 14.5). `task.reopen` asks for an
 * unstarted state, which is what "reopened" means to the core; the label a
 * person reads is the state record's.
 */
export async function setState(
  tx: TenantQuery,
  context: CommandContext,
  category: MachineCategory,
  reason?: string,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('setState: the envelope read no target');

  const current = context.spine.states.find((state) => state.id === target.data['state']);
  if (current?.machineCategory === category) {
    return refused(
      refuseCommand(
        'TRANSITION_NOT_PERMITTED',
        [current.key],
        [
          `This task is already ${category}. There is nothing for this command to change.`,
          'A repeat with the same operation_id replays; a new identity is a new request.',
        ],
      ),
    );
  }
  if (category === 'unstarted' && current?.machineCategory !== 'completed') {
    return refused(
      refuseCommand(
        'TRANSITION_NOT_PERMITTED',
        [current?.key ?? 'no state'],
        [
          'Only a completed task can be reopened.',
          'Call task.start to pick up a task that has not been completed.',
        ],
      ),
    );
  }

  const state = context.spine.states.find((candidate) => candidate.machineCategory === category);
  if (state === undefined) {
    return refused(
      refuseCommand(
        'NOT_FOUND',
        [category],
        [
          `This installation seeds no state in the ${category} category.`,
          'Seed one, or use a state whose category this installation carries.',
        ],
      ),
    );
  }

  const moved = await setTaskState(tx, {
    taskId: target.id,
    stateId: state.id,
    taskStateTypeId: context.spine.taskStateTypeId,
  });
  if (isRecordsRefusal(moved)) return refused(fromRecords(moved));

  const rows = await tx.query<{ readonly revision: string }>(
    `select revision::text as revision from records where business_id = $1 and id = $2`,
    [tx.businessId, target.id],
  );
  const revision = rows[0]?.revision;
  return applied(target.id, revision === undefined ? null : Number(revision), {
    state: state.key,
    completedAt: moved.completedAt === null ? null : moved.completedAt.toISOString(),
    ...(reason === undefined ? {} : { reason }),
  });
}

/** Write the fields this command's name owns, and refuse the ones it does not. */
export async function writeOwnedFields(
  tx: TenantQuery,
  context: CommandContext,
  command: CommandName,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('writeOwnedFields: the envelope read no target');

  const definitions = await readFieldDefinitions(tx, context.spine.taskTypeId);
  const live = new Map(definitions.filter((field) => isLive(field)).map((f) => [f.key, f]));
  const keys = Object.keys(fields).toSorted();

  if (keys.length === 0) {
    return refused(
      refuseCommand(
        'FIELD_UNKNOWN',
        [],
        [`${command} writes the fields it owns, and this payload named none of them.`],
      ),
    );
  }

  const unknown = keys.filter((key) => !live.has(key));
  if (unknown.length > 0) {
    return refused(
      refuseCommand('FIELD_UNKNOWN', unknown, [
        'This record type has no such field, or the field was deactivated.',
      ]),
    );
  }

  const derived = keys.filter((key) => live.get(key)?.writeMode === 'system');
  if (derived.length > 0) {
    return refused(
      refuseCommand('FIELD_NOT_WRITABLE', derived, [
        'This field is derived. No operation takes it as an input, on any surface.',
      ]),
      Object.fromEntries(derived.map((key) => [key, fields[key]])),
    );
  }

  const strayed = keys.filter((key) => {
    const field = live.get(key);
    return field !== undefined && !writerOf(field).includes(command);
  });
  if (strayed.length > 0) {
    return refused(
      refuseCommand(
        'TRANSITION_PROTECTED',
        strayed.map((key) => `${key}=${writerOf(live.get(key) as FieldDefinition).join(' ')}`),
        [`${command} does not own these fields. Call the operation named beside each one.`],
      ),
    );
  }

  const mistyped = refuseWrongValueType(definitions, fields);
  if (mistyped !== undefined) return refused(mistyped);

  const merged = mergeFieldValues(target.data, fields);
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = $3 where business_id = $1 and id = $2 and deleted_at is null
     returning revision::text as revision`,
    [tx.businessId, target.id, merged],
  );
  const written = rows[0];
  if (written === undefined) {
    return refused(refuseCommand('NOT_FOUND', [], ['No live task carries that identifier here.']));
  }
  return applied(target.id, Number(written.revision), { changed: keys });
}
