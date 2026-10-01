// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.duplicate`: Duplicate without contents (MP-4-8, CS-4.12, owner lines
// 75 and 76).
//
// Once a task has content its client is locked, and the way to serve another
// client is a new task from the bare shell. The command takes the old task's
// id, the chosen client and the shell as the person edited it (the title and
// the step names), and writes exactly that: a task of the old task's type for
// the chosen client, one subtask per step name, and nothing else. It reads one
// thing of the old task, its type; the old task is untouched.
//
// Both parts of the authority are asked here, inside the transaction that
// creates the task, with the caller's task grants held for share: `task:write` for the chosen
// client (party scope, or the business when there is none) and `task:read` on
// the old task, at record scope as `task.read` asks it. So a read revoked after
// the draft opened refuses the create. An agent never reaches this: the row is
// person-only on every surface.
//
// The carried text guard comes from here, so the app, the API and the command
// line give the same answer: a title or step name that names the old task's
// client, or an alias on its client record, is refused naming the fields until
// the person confirms it. The refusal carries the field names only, never the
// name it matched.
//
// The new task records where it came from as a `duplicated_from` link to the
// old task. `task.read` shows that id only to a reader who holds read on the
// old task (`reads/tasks.ts`), so the new client's people learn nothing of it.

import {
  deriveSource,
  isRecordsRefusal,
  isUuid,
  nextTaskKey,
  planTaskPlacement,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Scope, TenantQuery } from '../../../core-records/src/index.ts';
import {
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
} from '../../../core-runtime/src/index.ts';
import { randomUUID } from 'node:crypto';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { storableText } from './values.ts';
import { applied, isRefused, refused, type HandlerOutcome } from './outcome.ts';
import { createTask } from './tasks-write.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';

type DuplicateRequest = Extract<CommandRequest, { command: 'task.duplicate' }>;

/** The link the new task carries to the task it was duplicated from. */
export const DUPLICATED_FROM = 'duplicated_from';

/** The most step names one duplicate takes, and the longest name. */
const STEP_LIMIT = 200;
const TEXT_LIMIT = 500;

/** The edited shell, checked, with the client lower-cased as the uuid cast answers. */
interface Shell {
  readonly client: string | null;
  readonly title: string;
  readonly stepNames: readonly string[];
}

const usable = (text: unknown): text is string =>
  typeof text === 'string' && text.trim() !== '' && text.length <= TEXT_LIMIT && storableText(text);

/** The shell as sent, or the refusal naming what is not usable. */
function checkShell(request: DuplicateRequest): Shell | CommandRefusal {
  if (request.client !== null && !isUuid(request.client)) return refuseNotFound();
  if (!usable(request.title)) {
    return refuseCommand(
      'FIELD_VALUE_INVALID',
      ['title'],
      [`Send the new task's title: 1 to ${String(TEXT_LIMIT)} characters.`],
    );
  }
  const steps = request.stepNames;
  if (!Array.isArray(steps) || steps.length > STEP_LIMIT) {
    return refuseCommand(
      'FIELD_VALUE_INVALID',
      ['stepNames'],
      [`Send stepNames as a list of at most ${String(STEP_LIMIT)} names, [] for none.`],
    );
  }
  const bad = steps.flatMap((name, index) => (usable(name) ? [] : [`stepNames.${String(index)}`]));
  if (bad.length > 0) {
    return refuseCommand('FIELD_VALUE_INVALID', bad, [
      `Each step name is 1 to ${String(TEXT_LIMIT)} characters.`,
    ]);
  }
  return {
    client: request.client === null ? null : request.client.toLowerCase(),
    title: request.title,
    stepNames: steps as string[],
  };
}

/**
 * Text as the guard compares it: compatibility forms folded (full-width
 * letters), invisible format characters dropped, case folded and every run
 * of whitespace one space, so a spacing, case or width trick is the name.
 */
function folded(text: string): string {
  return text
    .normalize('NFKC')
    .replaceAll(/\p{Cf}/gu, '')
    .toLowerCase()
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

/**
 * The old client's name and aliases, folded, from its client record: a record
 * of the business's `client` type, `name` text and `aliases` a list of text.
 * The client model is not on this base; until it installs that type, no name
 * is known here and the guard warns on nothing.
 */
async function clientNames(tx: TenantQuery, client: string | null): Promise<readonly string[]> {
  if (client === null) return [];
  const rows = await tx.query<{ readonly name: unknown; readonly aliases: unknown }>(
    `select r.data -> 'name' as name, r.data -> 'aliases' as aliases
       from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and t.key = 'client' and r.id = $2 and r.deleted_at is null`,
    [tx.businessId, client],
  );
  const row = rows[0];
  if (row === undefined) return [];
  const aliases = Array.isArray(row.aliases) ? (row.aliases as unknown[]) : [];
  return [row.name, ...aliases]
    .filter((one): one is string => typeof one === 'string')
    .map((one) => folded(one))
    .filter((one) => one !== '');
}

/** The carried fields that name the old client, sorted; empty when none does. */
async function namingFields(
  tx: TenantQuery,
  oldClient: string | null,
  shell: Shell,
): Promise<readonly string[]> {
  const names = await clientNames(tx, oldClient);
  if (names.length === 0) return [];
  const fields: [string, string][] = [
    ['title', shell.title],
    ...shell.stepNames.map((name, index): [string, string] => [`stepNames.${String(index)}`, name]),
  ];
  return fields
    .filter(([, text]) => names.some((name) => folded(text).includes(name)))
    .map(([field]) => field)
    .toSorted();
}

/**
 * Both parts of the authority, asked with the caller's task grants held for
 * share, before the old task's row is locked (grants before records, as
 * `task.decide` holds them): a revocation that committed first is seen, and
 * one that comes second waits for this transaction. Asked at the clock after
 * the hold, so a grant that lapsed while this waited no longer counts.
 */
async function refuseAuthority(
  tx: TenantQuery,
  context: CommandContext,
  oldId: string,
  client: string | null,
): Promise<CommandRefusal | undefined> {
  const subjects = subjectsOf(context.session);
  const there: Scope =
    client === null ? { kind: 'business', id: null } : { kind: 'party', id: client };
  await holdCoveringGrants(tx, subjects, 'task');
  const at = await lockedInstant(tx);
  const reads = await checkAuthorityAt(
    tx,
    subjects,
    { collection: 'task', action: 'read', scope: { kind: 'record', id: oldId } },
    at,
  );
  if (!reads.ok) return reads.refusal;
  const writes = await checkAuthorityAt(
    tx,
    subjects,
    { collection: 'task', action: 'write', scope: there },
    at,
  );
  return writes.ok ? undefined : writes.refusal;
}

/**
 * The old task's type and client, read under a share lock so it cannot be
 * purged while the link to it is written. Live only: a trashed task is
 * answered as a missing one.
 */
async function readOld(
  tx: TenantQuery,
  taskTypeId: string,
  oldId: string,
): Promise<{ readonly typeId: string; readonly client: string | null } | undefined> {
  const rows = await tx.query<{ readonly type_id: string; readonly client: string | null }>(
    `select record_type_id as type_id, uuid_7::text as client from public.records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null
      for share`,
    [tx.businessId, taskTypeId, oldId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { typeId: row.type_id, client: row.client };
}

/** The new top-level task: the shell's title, the chosen client, the server's placement. */
async function insertShell(
  tx: TenantQuery,
  context: CommandContext,
  typeId: string,
  shell: Shell,
): Promise<{ readonly id: string; readonly key: string } | CommandRefusal> {
  const placement = await planTaskPlacement(tx, typeId, { parentId: null, board: null });
  if (isRecordsRefusal(placement)) return placement;
  const state = context.spine.states.find((one) => one.machineCategory === 'unstarted')?.id;
  const id = randomUUID();
  const data: Record<string, unknown> = {
    title: shell.title,
    key: await nextTaskKey(tx, typeId),
    source: deriveSource('person', context.entryPoint),
    board_rank: placement.boardRank,
    ...(state === undefined ? {} : { state }),
    ...(shell.client === null ? {} : { client: shell.client }),
  };
  await tx.query(
    `insert into public.records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
    [tx.businessId, id, typeId, data],
  );
  return { id, key: String(data['key']) };
}

/** `task.duplicate`: the checks, then the shell, its steps and its link, in one act. */
export async function duplicateTask(
  tx: TenantQuery,
  context: CommandContext,
  request: DuplicateRequest,
): Promise<HandlerOutcome> {
  const shell = checkShell(request);
  if ('code' in shell) return refused(shell);
  const oldId = request.recordId.toLowerCase();
  const unauthorised = await refuseAuthority(tx, context, oldId, shell.client);
  if (unauthorised !== undefined) return refused(unauthorised);
  const old = await readOld(tx, context.spine.taskTypeId, oldId);
  if (old === undefined) return refused(refuseNotFound());

  const naming = await namingFields(tx, old.client, shell);
  if (naming.length > 0 && request.confirmCarried !== true) {
    return refused(
      refuseCommand('CARRIED_TEXT_NAMES_CLIENT', naming, [
        'Each field named carries text that names the old task’s client.',
        'Edit it out, or send confirmCarried: true to create the task as sent.',
      ]),
    );
  }

  const made = await insertShell(tx, context, old.typeId, shell);
  if ('code' in made) return refused(made);
  for (const title of shell.stepNames) {
    // oxlint-disable-next-line no-await-in-loop -- each step is ranked after the one before
    const step = await createTask(tx, context, {
      command: 'task.create',
      operationId: request.operationId,
      fields: { title },
      parentId: made.id,
    });
    if (isRefused(step)) return step;
  }
  await tx.query(
    `insert into public.record_links (business_id, id, link_type, from_record_id, to_record_id)
     values ($1, $2, $3, $4, $5)`,
    [tx.businessId, randomUUID(), DUPLICATED_FROM, made.id, oldId],
  );
  const rows = await tx.query<{ readonly revision: string }>(
    `select revision::text as revision from public.records where business_id = $1 and id = $2`,
    [tx.businessId, made.id],
  );
  return applied(made.id, Number(rows[0]?.revision), { taskId: made.id, key: made.key });
}
