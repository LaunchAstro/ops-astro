// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat path's task proposal (designs/chat-path-slice.md, piece 2): a reply
// that ends in a task block (`readProposal`) is drawn as a card, and the
// person's one click is the only write.
//
// **Create** sends `task.create` with the title, the description and the
// conversation as its origin (`tasks-write.ts` `originOf`), starting nothing.
// Once it answers, `task.assign` gives the new task to whoever clicked, at the
// revision the create returned (`assignees.ts`), as the task draft assigns its
// own (`draft-command.ts`): the existing command and its checks, no new
// authority.
//
// **Edit** applies to the chat's own task at the revision its question was
// asked at. A question in a chat on a task first reads that task, before it is
// sent, so the revision kept is never newer than the one the answer read; an
// edit the reply proposes is bound to that task and revision, kept in the tab
// by the reply's message id so a reload keeps it too, and in memory as well, so a
// tab whose site storage refuses writes still applies a live edit. The click sends
// `task.update` at that revision: a task changed since is refused as stale and
// nothing newer is overwritten. The model never names the task, and a card with
// no kept baseline applies nothing.
//
// **Edit in a chat on no task** (#1666) applies to a task the chat created,
// which the person picks on the card from the reply's targets (`targets.ts`),
// at the revision the server kept with the reply. A reply with no usable
// targets draws no edit card. A stale or refused click shows the server's own
// reason.
//
// **One write per reply.** The click's operation id is derived from the
// reply's message id (a live reply's line and a kept one's both carry it) and
// its body is fixed by the reply, so a second click, or a reload and a click,
// presents the same attempt with the same payload, and the register replays its
// first outcome (`register-store.ts`), refusal included.

import type { AssistantMessage, AssistantPick, AssistantProposal } from '@launchastro/ui';
import {
  proposalCreate,
  proposalEdit,
  readProposal,
  sitePagesOf,
  type TaskReadResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { pathTo } from '../routes.ts';
import { isRecord, isUuid, jsonSlot, tabStorage } from '../session/storage-slot.ts';
import { keyIn, READ_LINE, type AssistantState, type Chat } from './chats.ts';
import { assignClicker } from './assignees.ts';
import { pickedTarget, targetsOf } from './targets.ts';

/** A live reply's card line: the server's message id after it, for the click. */
export const PROPOSAL_LINE = 'proposal-';

/** The reply's message id a card's line carries, or null on a line that has none. */
export function sourceOf(id: string): string | null {
  for (const prefix of [PROPOSAL_LINE, READ_LINE]) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return null;
}

/** The task the chat is open on: the scope it was asked under, or a kept conversation's. */
export const taskOf = (chat: Chat): string | null => chat.scope.task?.id ?? chat.taskId ?? null;

/**
 * A reply's line: its words and an offered card when it ends in a proposal
 * this chat may take, otherwise the body as written. An edit needs a task: the
 * chat's own, or, on no task, the reply's targets to pick from. A site change
 * (#1988) needs its page among the pages the server gave with it (`sitePages`).
 */
export function replyLine(
  body: string,
  onTask: boolean,
  targets?: unknown,
  sitePages?: unknown,
): Pick<AssistantMessage, 'body' | 'proposal'> {
  const { words, proposal } = readProposal(body, sitePagesOf(sitePages));
  const pick = proposal?.action === 'edit' && !onTask ? targetsOf(targets) : undefined;
  if (proposal === null || pick === null) return { body };
  const offered = { ...proposal, state: 'offered', task: null, refusal: null } as const;
  return { body: words, proposal: pick === undefined ? offered : { ...offered, pick } };
}

/**
 * The chat's task as its question was asked: what a proposed edit applies to.
 * Kept in the tab as opaque ids and a number only, as the kept tabs are
 * (`kept.ts`): no title or words stay behind after sign-out.
 */
export interface Baseline {
  readonly taskId: string;
  readonly revision: number;
}

/** At most this many baselines are kept in a tab, the newest. */
export const BASELINE_LIMIT = 32;

type Baselines = Readonly<Record<string, Baseline>>;

const isBaseline = (value: unknown): value is Baseline =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  isUuid(value['taskId']) &&
  Number.isSafeInteger(value['revision']);

const isBaselines = (value: unknown): value is Baselines =>
  isRecord(value) &&
  Object.keys(value).length <= BASELINE_LIMIT &&
  Object.keys(value).every((id) => isUuid(id)) &&
  Object.values(value).every((each) => isBaseline(each));

/** The session's own slot; with no session, none, so nothing is kept (as `kept.ts`). */
const baselineSlot = (grantKey: string | undefined) =>
  jsonSlot(
    grantKey === undefined ? null : tabStorage(),
    `ops-astro:proposal-baselines:${grantKey ?? ''}`,
    isBaselines,
  );

/**
 * The baselines kept in memory for one client's drawer, by session and reply,
 * so a refused storage write loses nothing a live card needs. A reload starts
 * empty and reads the tab's slot, as before.
 */
const held = new WeakMap<OperationsClient, Map<string, Baseline>>();

const heldBy = (client: OperationsClient): Map<string, Baseline> => {
  const found = held.get(client) ?? new Map<string, Baseline>();
  held.set(client, found);
  return found;
};

/** The baseline kept for a reply: memory first, then the tab's slot. */
function keptBaseline(view: ClickView, source: string): Baseline | undefined {
  if (view.grantKey === undefined) return undefined;
  const inMemory = heldBy(view.client).get(`${view.grantKey}:${source}`);
  return inMemory ?? baselineSlot(view.grantKey).read()?.[source];
}

/** The chat's task read before its question is sent; none off a task, or unread. */
export async function baselineOf(client: OperationsClient, chat: Chat): Promise<Baseline | null> {
  const taskId = taskOf(chat);
  if (taskId === null) return null;
  const read = settle(await client.read<TaskReadResult>('task.read', { recordId: taskId }));
  if (read.kind !== 'ok' || !('task' in read.value)) return null;
  return { taskId, revision: read.value.task.revision };
}

/** A reply's edit bound to the baseline its question was asked at, kept for the tab. */
export function keepBaseline(
  view: ClickView,
  reply: { readonly messageId: string; readonly body: string },
  baseline: Baseline | null,
): void {
  const { grantKey } = view;
  if (grantKey === undefined || baseline === null) return;
  if (readProposal(reply.body).proposal?.action !== 'edit') return;
  const memory = heldBy(view.client);
  memory.set(`${grantKey}:${reply.messageId}`, baseline);
  for (const oldest of [...memory.keys()].slice(0, -BASELINE_LIMIT)) memory.delete(oldest);
  const slot = baselineSlot(grantKey);
  const kept = Object.entries({ ...slot.read(), [reply.messageId]: baseline });
  slot.write(Object.fromEntries(kept.slice(-BASELINE_LIMIT)));
}

type Settled = Pick<AssistantProposal, 'state' | 'refusal' | 'task' | 'pick'>;

/** One card's click, in flight or answered, in tab `key` or the tab it was folded into. */
export function settleProposal(
  state: AssistantState,
  key: string,
  id: string,
  settled: Partial<Settled>,
): AssistantState {
  const into = keyIn(state, key);
  return {
    ...state,
    chats: state.chats.map((chat) =>
      chat.key === into
        ? {
            ...chat,
            messages: chat.messages.map((each) =>
              each.id === id && each.proposal !== undefined
                ? { ...each, proposal: { ...each.proposal, ...settled } }
                : each,
            ),
          }
        : chat,
    ),
  };
}

export const STALE_EDIT =
  'This task changed after the answer, so nothing was applied. Ask again for a change to the task as it is now.';

export const UNPICKED_EDIT =
  'This change is not tied to a task you picked in this tab, so it is not applied. Ask again to change the task.';

export const UNBOUND_EDIT =
  'This change is not tied to a version of the task kept in this tab, so it is not applied. Ask again to change the task.';

/** A click with no answer is offered again as unknown; a refusal, as it was. */
function unsettled(settled: Exclude<ReturnType<typeof settle>, { kind: 'ok' }>): Settled {
  const state = settled.kind === 'unknown' ? 'unknown' : 'offered';
  return { state, refusal: settled.because, task: null };
}

const taskLink = (label: string, key: string) => ({
  label,
  href: pathTo('agency:task-detail', { key }),
});

async function create(
  view: ClickView,
  chat: Chat,
  proposal: AssistantProposal,
  source: string,
): Promise<Settled> {
  const write = proposalCreate(proposal, source, chat.conversationId);
  const settled = settle(
    await view.client.mutate('task.create', write.body, { operationId: write.operationId }),
  );
  if (settled.kind !== 'ok') return unsettled(settled);
  const { detail, recordId, revision } = settled.value;
  const key = detail?.['key'];
  const task = taskLink(proposal.title ?? '', typeof key === 'string' ? key : recordId);
  const assigning = await assignClicker(view.client, source, { recordId, revision });
  if (assigning?.state === 'unknown') return { ...assigning, task: null };
  return { state: 'made', refusal: null, task, ...assigning };
}

/** The task an edit writes, at its revision: the chat's baseline, or the target picked. */
function boundOf(view: ClickView, pick: AssistantPick | undefined, source: string) {
  if (pick !== undefined) return pickedTarget(view.grantKey, source, pick);
  return keptBaseline(view, source) ?? null;
}

async function edit(
  view: ClickView,
  _chat: Chat,
  proposal: AssistantProposal,
  source: string,
): Promise<Settled> {
  const { pick } = proposal;
  const bound = boundOf(view, pick, source);
  const unbound = pick === undefined ? UNBOUND_EDIT : UNPICKED_EDIT;
  if (bound === null) return { state: 'stale', refusal: unbound, task: null };
  const write = proposalEdit(proposal, source, bound);
  const settled = settle(
    await view.client.mutate('task.update', write.body, {
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    }),
  );
  const frozen =
    pick === undefined ? {} : { pick: { ...pick, chosen: bound.taskId, frozen: true } };
  if (settled.kind === 'stale') {
    const refusal = pick === undefined ? STALE_EDIT : settled.because;
    return { state: 'stale', refusal, task: null, ...frozen };
  }
  if (settled.kind !== 'ok') return { ...unsettled(settled), ...frozen };
  const key = pick?.rows?.find((row) => row.id === bound.taskId)?.key ?? bound.taskId;
  return {
    state: 'made',
    refusal: null,
    task: taskLink(proposal.title ?? 'Open the task', key),
    ...frozen,
  };
}

/** The drawer's store, as much of it as the click reads and moves. */
export interface ProposalStore {
  readonly update: (move: (state: AssistantState) => AssistantState) => void;
  readonly chat: (key: string) => Chat | undefined;
}

export interface ClickView {
  readonly client: OperationsClient;
  readonly grantKey?: string | undefined;
}

/** A card's one click: one write, its answer settling the card. */
export async function sendProposal(
  view: ClickView,
  store: ProposalStore,
  card: { readonly key: string; readonly id: string },
): Promise<void> {
  const { key, id } = card;
  const chat = store.chat(key);
  const proposal = chat?.messages.find((each) => each.id === id)?.proposal;
  const source = sourceOf(id);
  if (chat === undefined || proposal === undefined || source === null) return;
  if (proposal.state !== 'offered' && proposal.state !== 'unknown') return;
  if (proposal.pick?.chosen === null) return;
  store.update((current) => settleProposal(current, key, id, { state: 'sending', refusal: null }));
  const send = proposal.action === 'create' ? create : edit;
  const settled = await send(view, chat, proposal, source);
  store.update((current) => settleProposal(current, key, id, settled));
}
