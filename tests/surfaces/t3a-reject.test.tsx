// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T3a, "Reject this proposal" on the proposal header (package 2 item 4, 27
// September 2026). Reject is the lineage's own action, outside the gate card,
// and always on offer while the lineage is live and its newest version has an
// open gate, at parity with `task.decide` on the API and the command line. It
// sends the newest version's gate and version, and a terminal lineage draws no
// reject at all.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const PEOPLE = [
  { personId: 'p-ada', name: 'Ada' },
  { personId: 'p-grace', name: 'Grace' },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function version(id: string, n: number, gate: Record<string, unknown> | null) {
  return {
    versionId: id,
    version: n,
    purpose: 'synthetic_comment',
    maximumMinor: 2_000,
    currency: 'AUD',
    payloadDigest: `digest-${id}`,
    payload: { change: 'a team-only comment' },
    supersededAt: null,
    runId: null,
    evidence: null,
    gate,
  };
}

const pending = (id: string) => ({
  id,
  state: 'pending',
  round: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
  expired: false,
});

/** One task; `versions` newest first, as the projection sends them. */
function server(versions: readonly ReturnType<typeof version>[], state = 'live') {
  const decided: Record<string, unknown>[] = [];
  const task = {
    id: '33333333-3333-4333-8333-333333333333',
    key: 'TSK-31',
    title: 'A task the worker proposed a change to',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 7,
    history: [],
    comments: [],
    proposals: [{ lineageId: 'l-1', state, versions, decisions: [], reservations: [] }],
  };
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: PEOPLE });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    if (at.endsWith('/task/decide')) {
      decided.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json({ recordId: task.id, revision: 7, detail: {} });
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(url, init))) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  return { client, decided };
}

const open = (client: OperationsClient) =>
  mount(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-31" />);

describe('T3a reject on the proposal header', () => {
  it('draws "Reject this proposal" on the lineage header, outside the gate card', async () => {
    const { client } = server([version('v-2', 2, pending('g-2'))]);
    const page = await open(client);
    await tick();

    const reject = page.find('[data-lineage-id="l-1"] [data-lineage-action="reject"]');
    expect(reject?.textContent).toBe('Reject this proposal');
    expect(page.find('[data-decide="controls"] [data-lineage-action="reject"]')).toBeNull();
    expect(page.find('[data-version-id] [data-lineage-action="reject"]')).toBeNull();
    await page.unmount();
  });

  it("sends task.decide's reject for the newest version's gate", async () => {
    const { client, decided } = server([
      version('v-2', 2, pending('g-2')),
      version('v-1', 1, { ...pending('g-1'), state: 'changes_requested' }),
    ]);
    const page = await open(client);
    await tick();

    await page.click('[data-lineage-action="reject"]');
    await tick();
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ decision: 'reject', gateId: 'g-2', versionId: 'v-2' });
    await page.unmount();
  });

  it('is on offer at the revision bound too, beside the gate controls', async () => {
    const { client } = server([version('v-3', 3, { ...pending('g-3'), round: 3 })]);
    const page = await open(client);
    await tick();

    expect(page.find('[data-lineage-action="reject"]')).not.toBeNull();
    await page.unmount();
  });

  it('draws no reject on a terminal lineage', async () => {
    const { client } = server(
      [version('v-2', 2, { ...pending('g-2'), state: 'rejected' })],
      'rejected',
    );
    const page = await open(client);
    await tick();

    expect(page.find('[data-lineage-action="reject"]')).toBeNull();
    await page.unmount();
  });
});

describe('T3a escalate at the bound', () => {
  it('is drawn in the gate card only at the bound, marked as having no visual reference', async () => {
    const before = server([version('v-2', 2, { ...pending('g-2'), round: 2 })]);
    const early = await open(before.client);
    await tick();
    expect(early.find('[data-decide="escalate"]')).toBeNull();
    await early.unmount();

    const { client } = server([version('v-3', 3, { ...pending('g-3'), round: 3 })]);
    const page = await open(client);
    await tick();
    const escalate = page.find('[data-decide="controls"] [data-decide="escalate"]');
    expect(escalate?.textContent).toBe('Escalate');
    expect(page.find('[data-escalate="form"]')?.getAttribute('data-ui-reference')).toBe('none');
    const options = page
      .all('[data-escalate="recipient"] option')
      .map((o) => o.getAttribute('value'));
    expect(options).toStrictEqual(['', 'p-ada', 'p-grace']);
    await page.unmount();
  });

  it("sends task.decide's escalate with the chosen recipient, and nothing without one", async () => {
    const { client, decided } = server([version('v-3', 3, { ...pending('g-3'), round: 3 })]);
    const page = await open(client);
    await tick();
    expect(page.find('[data-decide="escalate"]')?.hasAttribute('disabled')).toBe(true);
    await page.choose('[data-escalate="recipient"]', 'p-grace');
    await page.click('[data-decide="escalate"]');
    await tick();
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      decision: 'escalate',
      gateId: 'g-3',
      versionId: 'v-3',
      recipientPersonId: 'p-grace',
    });
    await page.unmount();
  });
});
