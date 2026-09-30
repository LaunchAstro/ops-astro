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

import {
  gatePending,
  readFieldDefinitions,
  isLive,
  isRecordsRefusal,
  mergeFieldValues,
  setTaskState,
  isWayfinderRecord,
} from '../../../core-records/src/index.ts';
import type {
  TenantQuery,
  FieldDefinition,
  MachineCategory,
  RefusalCode,
} from '../../../core-records/src/index.ts';
import { acquire } from '../../../core-runtime/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { refuseWrongValueType } from './values.ts';
import { applied, refused, type HandlerOutcome, type Refused } from './outcome.ts';
import type { CommandContext } from './context.ts';
import type { CommandName } from '../../../core-wire/src/index.ts';
import type { FieldValues } from './requests.ts';

/**
 * The task fields whose value is a person of this business.
 *
 * Named rather than derived, because nothing on a field definition says what a
 * uuid link points at, and a list here is a visible diff where a silent
 * derivation would not be. `client` is not in it: a party link resolves against
 * the party model, which this unit does not carry.
 */
const PERSON_LINK_FIELDS: readonly string[] = ['assignee', 'delegate'];

/** task.reopen's reason, held to the rule task.cancel applies to its own. */
const REASON_LIMIT = 500;

/**
 * Refuse a person link that names nobody here.
 *
 * `values.ts` checks that a uuid is a uuid and says in as many words that
 * whether it reaches anything is the owning operation's question. This is that
 * operation answering it. Without this, `task.assign` accepted the identifier
 * of a person in another business: the row was written, the read joined on the
 * business and returned no assignee, and the task ended up pointing at someone
 * who does not exist here -- acceptance case B2's negative, failing.
 *
 * The condition is the one `person.list` reads, so the people a screen offers
 * as assignees and the people the server will accept are one list rather than
 * two that drift.
 *
 * `NOT_FOUND` and not a code that says "wrong business". A person of another
 * business and an identifier that was never real are the same answer here, for
 * the reason every other NOT_FOUND in this tree is: the difference between them
 * is the inference.
 */
async function refusePersonNotHere(
  tx: TenantQuery,
  fields: FieldValues,
): Promise<CommandRefusal | undefined> {
  const named = PERSON_LINK_FIELDS.filter(
    (key) => typeof fields[key] === 'string' && fields[key] !== null,
  );
  if (named.length === 0) return undefined;

  // Lower-case, as the uuid cast answers: an
  // upper-case id of a member here is that member.
  const wanted = named.map((key) => (fields[key] as string).toLowerCase());
  const found = await tx.query<{ readonly id: string }>(
    `select p.id
       from public.people p
       join public.memberships m
         on m.business_id = p.business_id and m.person_id = p.id and m.active
      where p.business_id = $1 and p.id = any($2::uuid[])`,
    [tx.businessId, wanted],
  );
  const here = new Set(found.map((row) => row.id));
  const missing = named
    .filter((key) => !here.has((fields[key] as string).toLowerCase()))
    .toSorted();
  if (missing.length === 0) return undefined;
  return refuseCommand('NOT_FOUND', missing, [
    'No person of this business with an active membership carries that identifier.',
    'Read person.list for the people this business can be assigned work.',
  ]);
}

/** Person links lower-cased; `refusePersonNotHere` has already said each is a member here. */
function canonicalPersonLinks(fields: FieldValues): FieldValues {
  const out: Record<string, unknown> = { ...fields };
  for (const key of PERSON_LINK_FIELDS) {
    const value = out[key];
    if (typeof value === 'string') out[key] = value.toLowerCase();
  }
  return out as FieldValues;
}

/** The one command that may write a field, from the field's own row. */
function writerOf(field: FieldDefinition): readonly string[] {
  if (field.writeMode === 'system') return [];
  if (field.owningOperation === null) return ['task.update'];
  return field.owningOperation.split(' ');
}

/** A refusal as a handler answers it, for the checks that carry no attempted values. */
function refuse(code: RefusalCode, names: readonly string[], fixes: readonly string[]): Refused {
  return refused(refuseCommand(code, names, fixes));
}

/** The lifecycle does not move this way from the state the task is in. */
const notPermitted = (from: string, fixes: readonly string[]): Refused =>
  refuse('TRANSITION_NOT_PERMITTED', [from], fixes);

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
  reason?: unknown,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('setState: the envelope read no target');

  // `reason` is a required field of task.reopen
  // (API.md), recorded in the applied detail as why the task was reopened, so
  // it is held to task.cancel's rule before anything is written.
  if (
    category === 'unstarted' &&
    (typeof reason !== 'string' || reason.trim() === '' || reason.length > REASON_LIMIT)
  ) {
    return refuse(
      'FIELD_VALUE_INVALID',
      ['reason'],
      [`Say why the task is reopened, in 1 to ${String(REASON_LIMIT)} characters.`],
    );
  }

  const current = context.spine.states.find((state) => state.id === target.data['state']);
  if (current?.machineCategory === category) {
    return notPermitted(current.key, [
      `This task is already ${category}. There is nothing for this command to change.`,
      'A repeat with the same operation_id replays; a new identity is a new request.',
    ]);
  }
  // Only task.reopen clears the completion stamp
  // (SPEC 14.1, DATA.md), and it takes a reason; start on a completed task
  // would clear it with neither.
  if (category === 'started' && current?.machineCategory === 'completed') {
    return notPermitted(current.key, [
      'A completed task is reopened first.',
      'Call task.reopen with a reason.',
    ]);
  }
  if (category === 'unstarted' && current?.machineCategory !== 'completed') {
    return notPermitted(current?.key ?? 'no state', [
      'Only a completed task can be reopened.',
      'Call task.start to pick up a task that has not been completed.',
    ]);
  }

  // Contract 4.3: a task is not completed while an approval gate on it is
  // open. A gate past its deadline is not open (`task.read` shows it expired).
  // Asked under the task lock, which `propose` takes before it raises a gate
  // and `decide` before it closes one, so neither can move under this read.
  if (category === 'completed') {
    await acquire(tx, [{ lockClass: 'task', id: target.id }]);
    if (await openGateOn(tx, target.id)) return refused(gatePending());
  }

  const state = context.spine.states.find((candidate) => candidate.machineCategory === category);
  if (state === undefined) {
    return refuse(
      'NOT_FOUND',
      [category],
      [
        `This installation seeds no state in the ${category} category.`,
        'Seed one, or use a state whose category this installation carries.',
      ],
    );
  }

  const moved = await setTaskState(tx, {
    taskId: target.id,
    stateId: state.id,
    taskStateTypeId: context.spine.taskStateTypeId,
  });
  if (isRecordsRefusal(moved)) return refused(moved);

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
    return refuse(
      'FIELD_UNKNOWN',
      [],
      [`${command} writes the fields it owns, and this payload named none of them.`],
    );
  }

  const unknown = keys.filter((key) => !live.has(key));
  if (unknown.length > 0) {
    return refuse('FIELD_UNKNOWN', unknown, [
      'This record type has no such field, or the field was deactivated.',
    ]);
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

  const absent = await refusePersonNotHere(tx, fields);
  if (absent !== undefined) return refused(absent);

  // A map, its tickets and their threads never reach a client surface (WF-1).
  if (
    command === 'task.set_audience' &&
    fields['client_visible'] === true &&
    (await isWayfinderRecord(tx, target.id))
  ) {
    return refused(
      refuseCommand(
        'TRANSITION_NOT_PERMITTED',
        ['client_visible'],
        ['A map and its tickets stay internal; share a finished document instead.'],
      ),
    );
  }

  // Stored in the spelling the uuid cast answers, so the task names the
  // person in the one form every read and join compares against.
  const merged = mergeFieldValues(target.data, canonicalPersonLinks(fields));
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = $3 where business_id = $1 and id = $2 and deleted_at is null
     returning revision::text as revision`,
    [tx.businessId, target.id, merged],
  );
  const written = rows[0];
  if (written === undefined) {
    return refuse('NOT_FOUND', [], ['No live task carries that identifier here.']);
  }
  return applied(target.id, Number(written.revision), { changed: keys });
}

/** Whether a pending gate before its deadline sits on any lineage of this task. */
async function openGateOn(tx: TenantQuery, taskId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly open: boolean }>(
    `select exists (
       select 1 from public.gates g
         join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
        where g.business_id = $1 and l.task_id = $2 and g.state = 'pending'
          and g.expires_at > now()) as open`,
    [tx.businessId, taskId],
  );
  return rows[0]?.open === true;
}
