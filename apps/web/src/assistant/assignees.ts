// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a chat card's new task goes to (the owner's call on chat-made tasks):
// whoever clicks Create, unless the reply's block names one person on the
// team. Names are matched against `team.list` alone, the business's own
// staff, read once a new task's card is drawn; the card shows the match before
// the click. Once the create answers, the click's `task.assign` gives the task
// to that person at the revision the create returned (`proposals.ts`).

import { useEffect, useState } from 'react';
import type { AssistantProposal } from '@launchastro/ui';
import { proposalAssign, type TeamListResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import type { Chat } from './chats.ts';
import type { ClickView, Settled } from './proposals.ts';

export const NOT_ON_TEAM =
  'No one person on your team here matches the name in this reply, so the task is assigned to you.';

const NOT_ASSIGNED = 'The task was created but not assigned:';

/** A name as a person says it: trimmed, single spaces, any case. */
const spoken = (name: string): string =>
  name.trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-AU');

export interface Assignee {
  readonly personId: string;
  readonly name: string;
  readonly note: string | null;
}

/**
 * Who a new task goes to: the one teammate the block names, by whole name or
 * by a first name no one else on the team has, else whoever clicks. Matched
 * against `team.list` alone, the business's own staff, so any other name (a
 * person of another business, a client's login, nobody, two people) falls
 * back in the same words and reveals nothing.
 */
export function assigneeOf(named: string | undefined, team: TeamListResult): Assignee {
  const you = { personId: team.you.toLowerCase(), name: 'you', note: null };
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

/** The tabs hold a card for a new task: who it goes to needs the team. */
const creating = (chats: readonly Chat[]): boolean =>
  chats.some((chat) => chat.messages.some((each) => each.proposal?.action === 'create'));

/** The team, read once a new task's card is drawn: who each such card's task goes to. */
export function useTeam(client: OperationsClient, chats: readonly Chat[]): TeamListResult | null {
  const [team, setTeam] = useState<TeamListResult | null>(null);
  const wanted = creating(chats);
  useEffect(() => {
    let live = true;
    const read = async (): Promise<void> => {
      const found = await teamOf(client);
      if (live) setTeam(found);
    };
    if (wanted) void read();
    return () => {
      live = false;
    };
  }, [client, wanted]);
  return team;
}

/** The tabs as drawn: each new task's card says who it goes to, once the team is read. */
export function assigned(chats: readonly Chat[], team: TeamListResult | null): Chat[] {
  if (team === null) return [...chats];
  const shown = (proposal: AssistantProposal): AssistantProposal => {
    if (proposal.action !== 'create') return proposal;
    const { name, note } = assigneeOf(proposal.assignee, team);
    return { ...proposal, assignedTo: { name, note } };
  };
  return chats.map((chat) => ({
    ...chat,
    messages: chat.messages.map((each) =>
      each.proposal === undefined ? each : { ...each, proposal: shown(each.proposal) },
    ),
  }));
}

/** The new task's assignment under the reply's own id: null once kept, else how the card settles. */
export async function assign(
  view: ClickView,
  proposal: AssistantProposal,
  source: string,
  task: { readonly recordId: string; readonly revision: number },
): Promise<Pick<Settled, 'state' | 'refusal'> | null> {
  const team = view.team ?? (await teamOf(view.client));
  if (team === null)
    return { state: 'made', refusal: `${NOT_ASSIGNED} the team could not be read.` };
  const write = proposalAssign(source, task, assigneeOf(proposal.assignee, team).personId);
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
