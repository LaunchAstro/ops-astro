// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat path's task proposal (designs/chat-path-slice.md, piece 2): a reply
// that ends in a task block (`readProposal`) is drawn as a card, and the
// person's one click is the only write.
//
// **Create** sends `task.create` with the title, the description and the
// conversation as its origin (`tasks-write.ts` `originOf`), starting nothing.
// Once it answers, `task.assign` gives the new task, at the revision the create
// returned, to whoever clicked, or to the one teammate the block names
// (`assigneeOf`), as the task draft assigns its own (`draft-command.ts`): the
// existing command and its checks, no new authority. The card shows who
// before the click.
//
// **Edit** applies to the chat's own task at the revision its question was
// asked at. A question in a chat on a task first reads that task, before it is
// sent, so the revision kept is never newer than the one the answer read; an
// edit the reply proposes is bound to that task and revision, kept in the tab
// by the reply's message id so a reload keeps it too. The click sends
// `task.update` at that revision: a task changed since is refused as stale and
// nothing newer is overwritten. A chat on no task draws no edit card, the model
// never names the task, and a card with no kept baseline applies nothing.
//
// **One write per reply.** The click's operation id is derived from the
// reply's message id (a live reply's line and a kept one's both carry it) and
// its body is fixed by the reply, so a second click, or a reload and a click,
// presents the same attempt with the same payload, and the register replays its
// first outcome (`register-store.ts`), refusal included.

import { useMemo } from 'react';
import type { AssistantMessage, AssistantProposal } from '@launchastro/ui';
import {
  proposalCreate,
  proposalEdit,
  readProposal,
  type TaskReadResult,
  type TeamListResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { pathTo } from '../routes.ts';
import { isRecord, isUuid, jsonSlot, tabStorage } from '../session/storage-slot.ts';
import { keyIn, READ_LINE, type AssistantState, type Chat } from './chats.ts';
import { assign, assigned, keptAssignee, useTeam } from './assignees.ts';

/** A live reply's card line: the server's message id after it, for the click. */
export const PROPOSAL_LINE = 'proposal-';

/** The reply's message id a card's line carries, or null on a line that has none. */
function sourceOf(id: string): string | null {
  for (const prefix of [PROPOSAL_LINE, READ_LINE]) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return null;
}

/** The task the chat is open on: the scope it was asked under, or a kept conversation's. */
export const taskOf = (chat: Chat): string | null => chat.scope.task?.id ?? chat.taskId ?? null;

/**
 * A reply's line: its words and an offered card when it ends in a proposal
 * this chat may take, otherwise the body as written. An edit needs a task.
 */
export function replyLine(
  body: string,
  onTask: boolean,
): Pick<AssistantMessage, 'body' | 'proposal'> {
  const { words, proposal } = readProposal(body);
  if (proposal === null || (proposal.action === 'edit' && !onTask)) return { body };
  return { body: words, proposal: { ...proposal, state: 'offered', task: null, refusal: null } };
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
  grantKey: string | undefined,
  reply: { readonly messageId: string; readonly body: string },
  baseline: Baseline | null,
): void {
  if (baseline === null || readProposal(reply.body).proposal?.action !== 'edit') return;
  const slot = baselineSlot(grantKey);
  const kept = Object.entries({ ...slot.read(), [reply.messageId]: baseline });
  slot.write(Object.fromEntries(kept.slice(-BASELINE_LIMIT)));
}

type Settled = Pick<AssistantProposal, 'state' | 'refusal' | 'task'>;

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
  const assigning = await assign(view, proposal, source, { recordId, revision });
  if (assigning?.state === 'unknown') return { ...assigning, task: null };
  return { state: 'made', refusal: null, task, ...assigning };
}

async function edit(
  view: ClickView,
  _chat: Chat,
  proposal: AssistantProposal,
  source: string,
): Promise<Settled> {
  const baseline = baselineSlot(view.grantKey).read()?.[source];
  if (baseline === undefined) return { state: 'stale', refusal: UNBOUND_EDIT, task: null };
  const write = proposalEdit(proposal, source, baseline);
  const settled = settle(
    await view.client.mutate('task.update', write.body, {
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    }),
  );
  if (settled.kind === 'stale') return { state: 'stale', refusal: STALE_EDIT, task: null };
  if (settled.kind !== 'ok') return unsettled(settled);
  return {
    state: 'made',
    refusal: null,
    task: taskLink(proposal.title ?? 'Open the task', baseline.taskId),
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
  /** The team the cards were drawn with; unread, the click reads it. */
  readonly team?: TeamListResult | null;
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
  store.update((current) => settleProposal(current, key, id, { state: 'sending', refusal: null }));
  const send = proposal.action === 'create' ? create : edit;
  const settled = await send(view, chat, proposal, source);
  store.update((current) => settleProposal(current, key, id, settled));
}

/** The tabs as drawn, each new task's card saying who it goes to, and the cards' one click. */
export function useProposalCards(
  view: ClickView,
  store: ProposalStore & { state: AssistantState },
) {
  const team = useTeam(view.client, store.state.chats);
  const { grantKey } = view;
  const chats = useMemo(
    () => assigned(store.state.chats, team, (line) => keptAssignee(grantKey, sourceOf(line))),
    [store.state.chats, team, grantKey],
  );
  const onPropose = (key: string, id: string): void =>
    void sendProposal({ ...view, team }, store, { key, id });
  return { chats, onPropose };
}
