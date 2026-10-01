// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// UI-POLISH B4, the task page drawn as the mockup draws it (TASK-PAGE.md S5,
// S6): the read-only field grid under the header (TP-10) in the mockup's
// order, the gate as the gate box (DS-TASK-7) with its line, its exact
// version and its controls inside it, and no Refresh above a failed read,
// which draws its own Try again.

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const gate = (id: string) => ({
  id,
  state: 'pending',
  round: 1,
  expiresAt: '2099-01-01T00:00:00.000Z',
  expired: false,
  payloadDigest: 'sha256:abc',
});

const version = (id: string, n: number, withGate: boolean) => ({
  versionId: id,
  version: n,
  purpose: 'synthetic_comment',
  maximumMinor: 2_000,
  currency: 'AUD',
  payloadDigest: 'sha256:abc',
  payload: { change: 'a team-only comment' },
  supersededAt: null,
  runId: null,
  evidence: null,
  gate: withGate ? gate(`g-${id}`) : null,
});

const TASK = {
  id: '33333333-3333-4333-8333-333333333333',
  key: 'TSK-41',
  title: 'A task drawn as the mockup draws it',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: { personId: 'p-1', name: 'Ada' },
  due: '2026-10-07T00:00:00.000Z',
  priority: null,
  completedAt: null,
  revision: 3,
  history: [],
  comments: [],
};

function client(read: () => Response) {
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (at.endsWith('/task/read')) return Promise.resolve(read());
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
}

const open = (read: () => Response) =>
  mount(<TaskDetailScreen client={client(read)} grantKey="alpha:ada" taskKey="TSK-41" />);

const withProposal = (versions: readonly ReturnType<typeof version>[]) => () =>
  json({
    ok: true,
    task: {
      ...TASK,
      proposals: [{ lineageId: 'l-1', state: 'live', versions, decisions: [], reservations: [] }],
    },
  });

describe('B4 the task page as the mockup draws it', () => {
  it('draws the read-only field grid in the mockup order, sample values where nothing is built', async () => {
    const page = await open(withProposal([]));
    await tick();

    const labels = page.all('.tpr__facts .tf__k').map((key) => key.textContent);
    expect(labels).toStrictEqual([
      'Assignee',
      'Client',
      'Due date',
      'Estimate',
      'Project',
      'Category',
      'Stage',
      'Status',
      'Page link',
      'Handling',
    ]);
    const values = page.all('.tpr__facts .sb__state').map((value) => value.textContent);
    expect(values[0]).toBe('Ada');
    // No read carries a client on batch/1: a sample value, inside the mock label.
    expect(values[1]).toBe('Meridian Dental');
    expect(
      page.all('.tpr__facts .sb__state')[1]?.closest('[data-provenance="mock"]'),
    ).not.toBeNull();
    expect(values[2]).toBe('2026-10-07');
    expect(values[7]).toBe('Active');
    await page.unmount();
  });
});

describe('B4 the gate box', () => {
  it('draws an open gate as the armed gate box, its controls inside it', async () => {
    const page = await open(withProposal([version('v-2', 2, true)]));
    await tick();

    const box = page.find('.gatebox');
    expect(box).not.toBeNull();
    expect(box?.classList.contains('gatebox--stale')).toBe(false);
    expect(box?.querySelector('.gate.gate--armed .gate__word')?.textContent).toBe(
      'Human approval gate',
    );
    const line = box?.querySelector<HTMLElement>('[data-gate-state]');
    expect(line?.dataset['gateState']).toBe('pending');
    expect(box?.querySelector('.sout__row .sb__state')?.textContent).toContain('v2');
    const acts = box?.querySelectorAll('.gatebox__acts button') ?? [];
    expect([...acts].map((button) => button.className)).toStrictEqual([
      'btn btn--sm btn--secondary',
      'btn btn--sm btn--primary',
    ]);
    await page.unmount();
  });

  it('draws a gate on a superseded version as the stale gate box, not armed', async () => {
    const page = await open(withProposal([version('v-3', 3, false), version('v-2', 2, true)]));
    await tick();

    const box = page.find('.gatebox--stale');
    expect(box).not.toBeNull();
    expect(box?.querySelector('.gate--armed')).toBeNull();
    expect(box?.querySelector('[data-gate="stale"]')).not.toBeNull();
    await page.unmount();
  });

  it('draws no Refresh above a failed read, whose own Try again is the way on', async () => {
    const page = await open(() => json({ error: 'down' }, 503));
    await tick();

    expect(page.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(page.find('[data-refresh="task"]')).toBeNull();
    await page.unmount();
  });
});
