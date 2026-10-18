// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666: the tasks an edit card in a chat opened on no task may apply to. The
// server gives the conversation's owner, beside each reply, the tasks the chat
// had created (`ConversationTargetsView`), each at the revision kept with the
// reply, already filtered by the owner's current read. The model never names
// one: the person picks on the card (`proposal-pick.tsx`).
//
// **Read through a closed shape.** Targets with any other key, a position or
// task given twice, an id not in the uuid form, or a revision or position out
// of range draw no card at all, and neither do two tasks with no pick.
//
// **A pick is only a target.** A choice is taken only from a row the card
// shows, and the click writes only a target's task, at that target's revision:
// an id forged in the page or in the tab never reaches a write.
//
// **Frozen once clicked.** The click keeps the chosen task's id, and only the
// id, in the tab by the reply's message id, and every later click on that
// reply, after a reload too, sends that task again, so a retry presents the
// same payload under the same operation id and the register replays it. No
// later click pushes a choice out, and a choice the tab cannot keep is not
// sent: nothing is written that a reload could not send again.

import { PICK_SIZE, type AssistantPick, type AssistantPickMove } from '@launchastro/ui';
import { isRecord, isUuid, jsonSlot, tabStorage } from '../session/storage-slot.ts';

/** At most this many targets are read from one reply. */
export const TARGET_LIMIT = 500;

type Target = AssistantPick['targets'][number];

const exactly = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const isCount = (value: unknown, least: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= least;

function targetOf(value: unknown): (Target & { readonly n: number }) | null {
  if (!isRecord(value) || !exactly(value, ['n', 'taskId', 'revision'])) return null;
  const { n, taskId, revision } = value;
  if (!isCount(n, 1) || !isUuid(taskId) || !isCount(revision, 0)) return null;
  return { n, taskId, revision };
}

/** A reply's targets as an edit card's pick, nothing chosen unless there is one to name; else null. */
export function targetsOf(value: unknown): AssistantPick | null {
  if (!isRecord(value) || !exactly(value, ['pick', 'tasks'])) return null;
  const { pick, tasks } = value;
  if (typeof pick !== 'boolean' || !Array.isArray(tasks)) return null;
  if (tasks.length === 0 || tasks.length > TARGET_LIMIT || (!pick && tasks.length > 1)) return null;
  const read = tasks.map((each) => targetOf(each));
  const targets = read.filter((each) => each !== null);
  if (targets.length !== tasks.length) return null;
  const ordered = targets.every((each, at) => at === 0 || each.n > (targets[at - 1]?.n ?? 0));
  if (!ordered || new Set(targets.map((each) => each.taskId)).size !== targets.length) return null;
  return {
    required: pick,
    targets: targets.map(({ taskId, revision }) => ({ taskId, revision })),
    page: 0,
    rows: null,
    chosen: pick ? null : (targets[0]?.taskId ?? null),
    frozen: false,
  };
}

/** The targets on the pick's page: the only ones read. */
export const shown = (pick: AssistantPick): readonly Target[] =>
  pick.targets.slice(pick.page * PICK_SIZE, (pick.page + 1) * PICK_SIZE);

/** A person's move on the pick: a choice only of a row shown, a page only of those there are. */
export function moved(pick: AssistantPick, move: AssistantPickMove): AssistantPick {
  if (pick.frozen) return pick;
  if ('choose' in move) {
    const shownRow = pick.rows?.some((row) => row.id === move.choose) === true;
    return pick.required && shownRow ? { ...pick, chosen: move.choose } : pick;
  }
  const last = Math.ceil(pick.targets.length / PICK_SIZE) - 1;
  const { page } = move;
  if (!Number.isSafeInteger(page) || page < 0 || page > last || page === pick.page) return pick;
  return { ...pick, page, rows: null };
}

type Choices = Readonly<Record<string, string>>;

const isChoices = (value: unknown): value is Choices =>
  isRecord(value) && Object.entries(value).every(([id, taskId]) => isUuid(id) && isUuid(taskId));

/** The session's own slot; with no session, none, so nothing is kept (as `kept.ts`). */
const choiceSlot = (grantKey: string | undefined) =>
  jsonSlot(
    grantKey === undefined ? null : tabStorage(),
    `ops-astro:proposal-choices:${grantKey ?? ''}`,
    isChoices,
  );

/** The pick with the choice its reply's click froze in the tab, shown on its page; else as it is. */
export function restored(
  grantKey: string | undefined,
  source: string,
  pick: AssistantPick,
): AssistantPick {
  if (pick.frozen) return pick;
  const frozen = choiceSlot(grantKey).read()?.[source];
  const at = pick.targets.findIndex((each) => each.taskId === frozen);
  if (frozen === undefined || at < 0) return pick;
  return { ...pick, chosen: frozen, frozen: true, page: Math.floor(at / PICK_SIZE) };
}

/**
 * The target a click on reply `source` writes: the choice frozen in the tab,
 * or else the one chosen now, once the tab holds it frozen. Null when that is
 * no target, or the tab could not keep it.
 */
export function pickedTarget(
  grantKey: string | undefined,
  source: string,
  pick: AssistantPick,
): Target | null {
  const slot = choiceSlot(grantKey);
  const frozen = slot.read()?.[source];
  const target = pick.targets.find((each) => each.taskId === (frozen ?? pick.chosen));
  if (target === undefined) return null;
  if (frozen === undefined) {
    slot.write({ ...slot.read(), [source]: target.taskId });
    if (slot.read()?.[source] !== target.taskId) return null;
  }
  return target;
}
