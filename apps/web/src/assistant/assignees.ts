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

/** The team, read again as each new task's card is drawn: who that card's task goes to. */
export function useTeam(client: OperationsClient, chats: readonly Chat[]): TeamListResult | null {
  const [team, setTeam] = useState<TeamListResult | null>(null);
  const cards = creating(chats);
  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      const found = await teamOf(client);
      if (live) setTeam(found);
    };
    if (cards !== '') void read();
    return () => {
      live = false;
    };
  }, [client, cards]);
  return team;
}

/** At most this many first-sent assignees are kept in a tab, the newest. */
const KEPT_LIMIT = 32;

const isKept = (value: unknown): value is Readonly<Record<string, string>> =>
  isRecord(value) &&
  Object.keys(value).length <= KEPT_LIMIT &&
  Object.entries(value).every(([id, person]) => isUuid(id) && isUuid(person));

/**
 * The person each reply's click first sent its assignment to, by the reply's
 * message id, so every retry of that click, a reload's included, sends the
 * same body under its one operation id. Ids only, as `kept.ts` keeps the tabs;
 * with no session, none.
 */
const keptSlot = (grantKey: string | undefined) =>
  jsonSlot(
    grantKey === undefined ? null : tabStorage(),
    `ops-astro:proposal-assignees:${grantKey ?? ''}`,
    isKept,
  );

export const keptAssignee = (grantKey: string | undefined, source: string | null) =>
  source === null ? undefined : keptSlot(grantKey).read()?.[source];

/** Who a card shows: the one its click first sent, where kept, else who the team matches. */
function shownTo(team: TeamListResult, named: string | undefined, kept: string | undefined) {
  const fresh = assigneeOf(named, team);
  if (kept === undefined || kept === fresh.personId) return { name: fresh.name, note: fresh.note };
  const held = team.people.find((each) => each.personId.toLowerCase() === kept);
  return held === undefined ? undefined : { name: held.name, note: null };
}

/** The tabs as drawn: each new task's card says who it goes to, once the team is read. */
export function assigned(
  chats: readonly Chat[],
  team: TeamListResult | null,
  keptFor: (line: string) => string | undefined,
): Chat[] {
  if (team === null) return [...chats];
  const shown = (line: string, proposal: AssistantProposal): AssistantProposal => {
    if (proposal.action !== 'create') return proposal;
    const { assignedTo: _drawn, ...rest } = proposal;
    const to = shownTo(team, proposal.assignee, keptFor(line));
    return to === undefined ? rest : { ...rest, assignedTo: to };
  };
  return chats.map((chat) => ({
    ...chat,
    messages: chat.messages.map((each) =>
      each.proposal === undefined ? each : { ...each, proposal: shown(each.id, each.proposal) },
    ),
  }));
}

/** The new task's assignment under the reply's own id: null once kept, else how the card settles. */
export async function assign(
  view: {
    readonly client: OperationsClient;
    readonly team?: TeamListResult | null;
    readonly grantKey?: string | undefined;
  },
  proposal: AssistantProposal,
  source: string,
  task: { readonly recordId: string; readonly revision: number },
): Promise<Pick<AssistantProposal, 'state' | 'refusal'> | null> {
  const slot = keptSlot(view.grantKey);
  let personId = slot.read()?.[source];
  if (personId === undefined) {
    const team = view.team ?? (await teamOf(view.client));
    if (team === null) {
      return { state: 'made', refusal: `${NOT_ASSIGNED} the team could not be read.` };
    }
    personId = assigneeOf(proposal.assignee, team).personId;
    // Kept before it is sent: the click's intent, whatever the team becomes.
    const kept = Object.entries({ ...slot.read(), [source]: personId });
    slot.write(Object.fromEntries(kept.slice(-KEPT_LIMIT)));
  }
  const write = proposalAssign(source, task, personId);
  const settled = settle(
    await view.client.mutate('task.assign', write.body, {
      operationId: write.operationId,
      expectedRevision: write.expectedRevision,
    }),
  );
  if (settled.kind === 'ok') return null;
  if (settled.kind === 'unknown') return { state: 'unknown', refusal: settled.because };
  return { state: 'made', refusal: `${NOT_ASSIGNED} ${settled.because}` };
}
