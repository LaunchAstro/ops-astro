// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a chat card's new task goes to (the owner's call on chat-made tasks):
// whoever clicks Create, unless the reply's block names one person on the team
// (`team.list`, read again as each new task's card is drawn). The card shows
// who before the click; after the create, `task.assign` gives it to them at
// the create's revision, and the tab keeps who was sent so a retry sends the same.

import { useEffect, useState } from 'react';
import type { AssistantProposal } from '@launchastro/ui';
import { proposalAssign, type TeamListResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { isRecord, isUuid, jsonSlot, tabStorage } from '../session/storage-slot.ts';
import type { Chat } from './chats.ts';

export const NOT_ON_TEAM =
  'No one person on your team here matches the name in this reply, so the task is assigned to you.';

const NOT_ASSIGNED = 'The task was created but not assigned:';

/** A name as a person says it: trimmed, single spaces, any case. */
const spoken = (name: string): string =>
  name.trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-AU');

/**
 * Who a new task goes to: the one teammate the block names, by whole name or
 * by a first name no one else on the team has, else whoever clicks. Matched
 * against `team.list` alone, the business's own staff, so any other name (a
 * person of another business, a client's login, nobody, two people) falls
 * back in the same words and reveals nothing.
 */
export function assigneeOf(named: string | undefined, team: TeamListResult) {
  const you = { personId: team.you.toLowerCase(), name: 'you', note: null as string | null };
  if (named === undefined) return you;
  const wanted = spoken(named);
  const whole = team.people.filter((each) => spoken(each.name) === wanted);
  const first = team.people.filter((each) => spoken(each.name).split(' ')[0] === wanted);
  const [one, ...others] = whole.length > 0 ? whole : first;
  if (one === undefined || others.length > 0) return { ...you, note: NOT_ON_TEAM };
  const personId = one.personId.toLowerCase();
  return personId === you.personId ? you : { personId, name: one.name, note: null };
}

/** The business's staff and the reader, or null when the list cannot be read. */
export async function teamOf(client: OperationsClient): Promise<TeamListResult | null> {
  const read = settle(await client.read<TeamListResult>('team.list', {}));
  return read.kind === 'ok' ? read.value : null;
}

/** Each new task's card in the tabs, by line: each one drawn asks for the team as it is then. */
const creating = (chats: readonly Chat[]): string =>
  chats
    .flatMap((chat) => chat.messages.filter((each) => each.proposal?.action === 'create'))
    .map((each) => each.id)
    .join(' ');

/** A team read, and the cards drawn before it was asked: the ones it may match. */
export interface TeamRead {
  readonly team: TeamListResult | null;
  readonly cards: ReadonlySet<string>;
}

/**
 * The team, read again as each new task's card is drawn. A card is matched,
 * and its click uses this read, only once a read asked after it was drawn has
 * landed; until then its click reads the team itself.
 */
export function useTeam(client: OperationsClient, chats: readonly Chat[]): TeamRead {
  const [read, setRead] = useState<TeamRead>({ team: null, cards: new Set() });
  const cards = creating(chats);
  useEffect(() => {
    let live = true;
    const ask = async (): Promise<void> => {
      const team = await teamOf(client);
      if (live) setRead({ team, cards: new Set(cards.split(' ')) });
    };
    if (cards !== '') void ask();
    return () => {
      live = false;
    };
  }, [client, cards]);
  return read;
}

/** Settled assignments past this many are let go in a tab, the oldest first. */
const KEPT_LIMIT = 32;

/** The person a click sent, and whether its answer is still owed. */
interface Kept {
  readonly person: string;
  readonly open: boolean;
}

const isKept = (value: unknown): value is Readonly<Record<string, Kept>> =>
  isRecord(value) &&
  Object.entries(value).every(
    ([id, each]) =>
      isUuid(id) && isRecord(each) && isUuid(each['person']) && typeof each['open'] === 'boolean',
  );

/**
 * The person each reply's click first sent its assignment to, by the reply's
 * message id, so a retry after a reload sends the same body under its one
 * operation id. Ids only, as `kept.ts` keeps the tabs; with no session, none.
 * One still owed an answer is never let go: it is the body its retry must send.
 */
const keptSlot = (grantKey: string | undefined) =>
  jsonSlot(
    grantKey === undefined ? null : tabStorage(),
    `ops-astro:proposal-assignees:${grantKey ?? ''}`,
    isKept,
  );

function keep(grantKey: string | undefined, source: string, kept: Kept): void {
  const slot = keptSlot(grantKey);
  const all = Object.entries({ ...slot.read(), [source]: kept });
  let over = all.length - KEPT_LIMIT;
  const letGo = (id: string, each: Kept): boolean => over > 0 && !each.open && id !== source;
  slot.write(Object.fromEntries(all.filter(([id, each]) => !(letGo(id, each) && over-- > 0))));
}

export const keptAssignee = (grantKey: string | undefined, source: string) =>
  keptSlot(grantKey).read()?.[source]?.person;

/** Who a card shows: the one its click first sent, where kept, else who the team matches. */
function shownTo(team: TeamListResult, named: string | undefined, kept: string | undefined) {
  const fresh = assigneeOf(named, team);
  if (kept === undefined || kept === fresh.personId) return { name: fresh.name, note: fresh.note };
  const held = team.people.find((each) => each.personId.toLowerCase() === kept);
  return held === undefined ? undefined : { name: held.name, note: null };
}

/** The tabs as drawn: each new task's card says who it goes to, once a read after it lands. */
export function assigned(
  chats: readonly Chat[],
  { team, cards }: TeamRead,
  keptFor: (line: string) => string | undefined,
): Chat[] {
  const shown = (line: string, proposal: AssistantProposal): AssistantProposal => {
    if (proposal.action !== 'create') return proposal;
    const { assignedTo: _drawn, ...rest } = proposal;
    const to =
      team === null || !cards.has(line)
        ? undefined
        : shownTo(team, proposal.assignee, keptFor(line));
    return to === undefined ? rest : { ...rest, assignedTo: to };
  };
  return chats.map((chat) => ({
    ...chat,
    messages: chat.messages.map((each) =>
      each.proposal === undefined ? each : { ...each, proposal: shown(each.id, each.proposal) },
    ),
  }));
}

/** What the click's assignment reads: the team its card was matched with, and who was sent. */
export interface AssignView {
  readonly client: OperationsClient;
  readonly team?: TeamListResult | null;
  readonly grantKey?: string | undefined;
  /** Who each reply's click sent, while the drawer is open, whatever the tab could keep. */
  readonly sent?: Map<string, string>;
}

/** The new task's assignment under the reply's own id: null once kept, else how the card settles. */
export async function assign(
  view: AssignView,
  proposal: AssistantProposal,
  source: string,
  task: { readonly recordId: string; readonly revision: number },
): Promise<Pick<AssistantProposal, 'state' | 'refusal'> | null> {
  let person = view.sent?.get(source) ?? keptAssignee(view.grantKey, source);
  if (person === undefined) {
    const team = view.team ?? (await teamOf(view.client));
    if (team === null) {
      return { state: 'made', refusal: `${NOT_ASSIGNED} the team could not be read.` };
    }
    person = assigneeOf(proposal.assignee, team).personId;
  }
  // Held before it is sent: the click's intent, whatever the team becomes.
  view.sent?.set(source, person);
  keep(view.grantKey, source, { person, open: true });
  const write = proposalAssign(source, task, person);
  const settled = settle(
    await view.client.mutate('task.assign', write.body, {
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    }),
  );
  if (settled.kind === 'unknown') return { state: 'unknown', refusal: settled.because };
  keep(view.grantKey, source, { person, open: false });
  if (settled.kind === 'ok') return null;
  return { state: 'made', refusal: `${NOT_ASSIGNED} ${settled.because}` };
}
