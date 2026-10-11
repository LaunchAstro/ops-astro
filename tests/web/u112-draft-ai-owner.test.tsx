// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// U112 Core 04 5: the draft's Owner is a person, an AI agent (by name) or
// nobody, and each is kept through a reopen and written at Create by
// `task.assign`: a person as `assignee`, an agent as `agent`, nobody as no
// assignment at all. Assign to AI records the assignment and starts no run:
// Create sends nothing after the draft's own parts (owner, 11 Oct: a person
// clicks Launch). An older kept draft, whose owner has no kind, is a person.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { NEW_ID, NEW_KEY, create, draft, store, valueOf, type Sent } from './draft-support.tsx';
import { emptyDraft, readDraft } from '../../apps/web/src/screens/task/task-draft.ts';

afterEach(unmountAll);

const ADA = { personId: '11111111-1111-4111-8111-111111111111', name: 'Ada' };
const PENNY = { agentId: '22222222-2222-4222-8222-222222222222', name: 'Penny' };

/** Answers the people, the agents the reader may direct, the create and each part. */
function api() {
  const sent: Sent[] = [];
  let revision = 1;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/person/list') return Promise.resolve(json({ ok: true, persons: [ADA] }));
    if (to === '/task/board')
      return Promise.resolve(
        json({ ok: true, tasks: [], myAgents: [PENNY], viewer: 'p', owed: 0, changedAt: null }),
      );
    if (to === '/task/create')
      return Promise.resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
    revision += 1;
    return Promise.resolve(json({ recordId: NEW_ID, revision, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const reads = new Set(['/person/list', '/task/board']);
  return { client, writes: () => sent.filter((one) => !reads.has(one.to)) };
}

/** Focus the Owner select, which reads the people and agents, then choose `value`. */
async function chooseOwner(view: Awaited<ReturnType<typeof draft>>['view'], value: string) {
  await act(() => {
    view.host.querySelector<HTMLSelectElement>('#panel-draft-owner')?.focus();
  });
  await tick();
  await view.choose('#panel-draft-owner', value);
}

async function filed(owner: string | null) {
  const server = api();
  const storage = store();
  const first = await draft({ client: server.client, storage });
  await typeInto(first.view, '#panel-draft-name', 'Brief the booking page');
  if (owner !== null) await chooseOwner(first.view, owner);
  await first.view.unmount();
  const again = await draft({ client: server.client, storage });
  return { server, storage, again };
}

describe('Core 04 5: a person, an AI agent and nobody each read back as chosen', () => {
  it('the Owner offers nobody, the people by name and the AI agents by name', async () => {
    const { view } = await draft({ client: api().client });
    await chooseOwner(view, '');
    const offered = [...view.host.querySelectorAll<HTMLOptionElement>('#panel-draft-owner option')];
    expect(offered.map((option) => [option.value, option.textContent])).toStrictEqual([
      ['', 'Unassigned'],
      [`person:${ADA.personId}`, 'Ada'],
      [`agent:${PENNY.agentId}`, 'AI: Penny'],
    ]);
  });

  it('an AI agent is kept through a reopen and assigned as the agent, starting no run', async () => {
    const { server, again } = await filed(`agent:${PENNY.agentId}`);
    expect(valueOf(again.view, '#panel-draft-owner')).toBe(`agent:${PENNY.agentId}`);
    await create(again.view);
    expect(server.writes().map((one) => one.to)).toStrictEqual(['/task/create', '/task/assign']);
    expect(server.writes()[1]?.body).toMatchObject({
      recordId: NEW_ID,
      fields: { agent: PENNY.agentId },
      expectedRevision: 1,
    });
    expect(again.outcome.created).toBe(NEW_KEY);
  });

  it('a person is kept through a reopen and assigned as the assignee', async () => {
    const { server, again } = await filed(`person:${ADA.personId}`);
    expect(valueOf(again.view, '#panel-draft-owner')).toBe(`person:${ADA.personId}`);
    await create(again.view);
    expect(server.writes()[1]?.body).toMatchObject({ fields: { assignee: ADA.personId } });
  });

  it('nobody chosen writes no assignment', async () => {
    const { server, again } = await filed(null);
    expect(valueOf(again.view, '#panel-draft-owner')).toBe('');
    await create(again.view);
    expect(server.writes().map((one) => one.to)).toStrictEqual(['/task/create']);
  });
});

describe('Kept-draft storage stays compatible', () => {
  it('an older kept draft’s owner, with no kind, is a person', async () => {
    const storage = store();
    storage.setItem(
      'ops-astro.task-draft.ada',
      JSON.stringify({
        ...emptyDraft(null),
        title: 'Kept',
        owner: { id: ADA.personId, name: 'Ada' },
      }),
    );
    expect(readDraft(storage, 'ada')?.owner).toStrictEqual({ id: ADA.personId, name: 'Ada' });
    const server = api();
    const { view } = await draft({ client: server.client, storage, person: 'ada' });
    expect(valueOf(view, '#panel-draft-owner')).toBe(`person:${ADA.personId}`);
    await create(view);
    expect(server.writes()[1]?.body).toMatchObject({ fields: { assignee: ADA.personId } });
  });
});
