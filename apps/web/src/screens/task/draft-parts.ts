// SPDX-License-Identifier: AGPL-3.0-only
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { settle, type Settlement } from '../../records/use-command.ts';
import { isUuid } from '../../session/storage-slot.ts';
import {
  draftBody,
  draftRecipe,
  draftPart,
  isDraftBody,
  operationIds,
  partLabel,
  scopePart,
  type DraftPart,
} from './draft-recipe.ts';
import { command, phaseCommand } from './draft-command.ts';
import { commandAnswer, type DraftReceipt, type DraftCommand } from './draft-receipts.ts';
import type { Attempt, TaskDraft } from './task-draft.ts';
export type CreateOutcome =
  | { readonly kind: 'created'; readonly key: string; readonly missed: readonly string[] }
  | { readonly kind: 'refused' | 'unknown'; readonly because: string };
/** Command-specific answers preserve the parent's cursor; this remains the legacy mutable retry caller. */
function prepareDraft(draft: TaskDraft, attempt: Attempt) {
  const ids = [...attempt.parts];
  const recipe = draftRecipe((index, tagCreate) => {
    const id = ids[index] ?? `${attempt.id}.${String(index)}`;
    ids[index] = id;
    return tagCreate ? `${id}.tag` : id;
  }, draft);
  const body = draftBody(draft);
  const identities = [attempt.id, ...recipe.flatMap((part) => operationIds(part))];
  if (
    !isDraftBody(body) ||
    !recipe.every((part) => draftPart(part)) ||
    new Set(identities).size !== identities.length
  )
    return null;
  return { ids, recipe, body };
}
export async function createFromDraft(
  client: OperationsClient,
  draft: TaskDraft,
  attempt: Attempt,
  save: (next: Attempt) => void,
  recovering: boolean,
): Promise<CreateOutcome> {
  const prepared = prepareDraft(draft, attempt);
  if (prepared === null)
    return {
      kind: recovering ? 'unknown' : 'refused',
      because: recovering
        ? 'The draft operands are invalid. No recovery request was sent. The original create may already have applied.'
        : 'The draft operands are invalid. No creation request was sent.',
    };
  const { body } = prepared;
  const initial = command('task.create', attempt.id, body);
  const created = await write(client, initial, null);
  if (created.answer.kind !== 'ok')
    return {
      kind: created.answer.kind === 'unknown' ? 'unknown' : 'refused',
      because: created.answer.because,
    };
  return finishDraft(client, attempt, save, prepared, created.receipt!);
}
async function finishDraft(
  client: OperationsClient,
  attempt: Attempt,
  save: (next: Attempt) => void,
  prepared: NonNullable<ReturnType<typeof prepareDraft>>,
  base: DraftReceipt,
): Promise<CreateOutcome> {
  const { ids, recipe } = prepared;
  let parent = { ...base, revision: attempt.revision ?? base.revision };
  let done = attempt.done;
  const missed = [...attempt.missed];
  let tags: Map<string, string> | null = null;
  const now = (): Attempt => ({
    ...attempt,
    parts: [...ids],
    done,
    revision: parent.revision,
    missed: [...missed],
  });
  for (const [index, part] of recipe.entries()) {
    if (index < done) continue;
    save(now());
    let result: Written;
    if (part.kind === 'tag') {
      // eslint-disable-next-line no-await-in-loop -- Resolve the tag branch before its ordered write.
      tags ??= await vocabulary(client);
      // eslint-disable-next-line no-await-in-loop -- Each phase depends on the preceding receipt.
      result = await tagWrite(client, part, parent, tags);
      // eslint-disable-next-line no-await-in-loop -- Each phase depends on the preceding receipt.
    } else result = await write(client, phaseCommand(part, parent), parent);
    if (result.answer.kind === 'unknown')
      return {
        kind: 'unknown',
        because: `No answer for ${partLabel(part)}; Create again to finish.`,
      };
    if (result.answer.kind === 'ok') {
      if (REVISES.has(part.kind)) parent = { ...result.receipt!, key: base.key };
    } else if (scopePart(part)) {
      // The rest would land outside the task's client or project: none of it is sent.
      missed.push(...recipe.slice(index).map((rest) => partLabel(rest)));
      done = recipe.length;
      save(now());
      break;
    } else missed.push(partLabel(part));
    done = index + 1;
    save(now());
  }
  return { kind: 'created', key: base.key ?? base.recordId!, missed };
}
/** The parts whose answer is the task's next revision. */
const REVISES = new Set<DraftPart['kind']>([
  'party',
  'board',
  'stage',
  'details',
  'category',
  'assignment',
]);
interface Written {
  readonly answer: Settlement;
  readonly receipt: DraftReceipt | null;
}
async function write(
  client: OperationsClient,
  current: DraftCommand,
  parent: DraftReceipt | null,
): Promise<Written> {
  const answer = settle(
    await client.mutate(current.command, current.body, {
      operationId: current.operationId,
      ...(current.expectedRevision === null ? {} : { expectedRevision: current.expectedRevision }),
    }),
  );
  const known = commandAnswer(answer, current, parent);
  return {
    answer:
      answer.kind !== 'unknown' && known === null
        ? { kind: 'unknown', because: 'The API did not return a valid creation phase answer.' }
        : answer,
    receipt: known?.receipt ?? null,
  };
}
async function tagWrite(
  client: OperationsClient,
  part: Extract<DraftPart, { kind: 'tag' }>,
  parent: DraftReceipt,
  tags: ReadonlyMap<string, string>,
): Promise<Written> {
  let tagId = tags.get(part.name.toLowerCase()) ?? null;
  if (tagId === null) {
    const made = await write(client, phaseCommand(part, parent), parent);
    if (made.answer.kind !== 'ok') return made;
    tagId = made.receipt!.identifier;
  }
  return write(client, phaseCommand(part, parent, tagId), parent);
}
/** Refused vocabulary retains typed tag creation under canonical command authority. */
async function vocabulary(client: OperationsClient): Promise<Map<string, string>> {
  const read = await client.read<{ readonly tags: readonly { id: string; name: string }[] }>(
    'tag.list',
    {},
  );
  const held = new Map<string, string>();
  if (isRefusal(read) || isUnavailable(read)) return held;
  for (const tag of read.value.tags) if (isUuid(tag.id)) held.set(tag.name.toLowerCase(), tag.id);
  return held;
}
