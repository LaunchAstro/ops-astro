// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// An expired gate on the task page (owner decision, 23 Sep 2026).
//
// `task.read` projects a gate that is stored `pending` past its deadline as
// `state: 'expired'`, `expired: true` (`docs/local/API.md`, "Proposal
// projection"). The page draws that as expired, offers no decision, and says
// why: the deadline passed with nobody deciding, and a new version raises a
// new gate.
//
// The other half is a decided gate. Its outcome stands whatever the clock
// says, so the page draws an approved gate as approved and never as expired,
// even from a server that sent `expired: true` beside it.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const DEADLINE = '2026-09-23T05:00:00.000Z';

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

function server(gate: { readonly state: string; readonly expired: boolean }) {
  const version = {
    versionId: 'v-1',
    version: 1,
    purpose: 'client_renewal_quote',
    maximumMinor: 250_000,
    currency: 'AUD',
    payloadDigest: 'digest-1',
    payload: { step: 'draft the quote' },
    supersededAt: null,
    runId: null,
    evidence: null,
    gate: {
      id: 'g-1',
      state: gate.state,
      round: 1,
      expiresAt: DEADLINE,
      expired: gate.expired,
      payloadDigest: 'digest-1',
    },
  };
  const task = {
    id: '44444444-4444-4444-8444-444444444444',
    key: 'TSK-41',
    title: 'A task whose proposal nobody decided in time',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 3,
    history: [],
    comments: [],
    proposals: [
      { lineageId: 'l-1', state: 'live', versions: [version], decisions: [], reservations: [] },
    ],
  };

  const decided: unknown[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    if (at.endsWith('/task/decide')) {
      decided.push(JSON.parse(String(init?.body ?? '{}')));
      return json({ refused: true, code: 'GATE_EXPIRED', names: [], fixes: [] }, 410);
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  }) as unknown as typeof globalThis.fetch;

  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
  return { client, decided };
}

const screenFor = (client: OperationsClient) => (
  <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-41" />
);

describe('an expired gate on the task page', () => {
  it('draws the gate as expired, offers no decision, and says why', async () => {
    const { client, decided } = server({ state: 'expired', expired: true });
    const page = await mount(screenFor(client));
    await tick();

    const gate = page.find('[data-gate-state]');
    expect(gate?.getAttribute('data-gate-state')).toBe('expired');
    expect(gate?.getAttribute('data-gate-expired')).toBe('true');
    expect(gate?.textContent).toContain('Gate expired');
    // The deadline is in the past, so the page does not call it upcoming.
    expect(gate?.textContent).not.toContain('expires');
    expect(gate?.textContent).toContain(`deadline ${DEADLINE}`);

    expect(page.find('[data-decide="approve"]')).toBeNull();
    expect(page.find('[data-decide="reject"]')).toBeNull();
    const why = page.find('[data-decide="closed"]')?.textContent ?? '';
    expect(why).toContain('without a decision');
    expect(why).toContain(DEADLINE);
    expect(why).toContain('new version');
    expect(decided).toHaveLength(0);

    await page.unmount();
  });

  it('draws a decided gate by its outcome, never as expired', async () => {
    const { client, decided } = server({ state: 'approved', expired: true });
    const page = await mount(screenFor(client));
    await tick();

    const gate = page.find('[data-gate-state]');
    expect(gate?.getAttribute('data-gate-state')).toBe('approved');
    expect(gate?.getAttribute('data-gate-expired')).toBe('false');
    expect(page.find('[data-gate="expired"]')).toBeNull();
    expect(page.find('[data-decide="approve"]')).toBeNull();
    const why = page.find('[data-decide="closed"]')?.textContent ?? '';
    expect(why).toContain('approved');
    expect(why).not.toContain('expired');
    expect(decided).toHaveLength(0);

    await page.unmount();
  });
});
