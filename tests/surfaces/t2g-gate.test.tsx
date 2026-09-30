// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T2g, the gate on the task page (product issue 12, package 2 items 3 and 4).
// The gate draws exactly two controls, "Request changes" and "Approve this
// version", each bound to the displayed version and each carrying the notice
// that the demonstration's one effect is a team-only comment. Reject is the
// proposal header's own action (T3a), never a third gate control. A gate whose
// version is no longer the lineage's newest reads "Gate stale", derived by
// comparing versions, and approve is disabled.

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
function server(versions: readonly ReturnType<typeof version>[]) {
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
    proposals: [{ lineageId: 'l-1', state: 'live', versions, decisions: [], reservations: [] }],
  };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    if (at.endsWith('/task/decide')) {
      decided.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return json({ recordId: task.id, revision: 7, detail: {} });
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  }) as unknown as typeof globalThis.fetch;
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

describe('T2g the gate on the task page', () => {
  it('draws exactly two controls, each bound to the displayed version, and no third', async () => {
    const { client } = server([version('v-2', 2, pending('g-2'))]);
    const page = await open(client);
    await tick();

    const controls = page.all('[data-decide="controls"] button');
    expect(controls.map((button) => button.textContent)).toStrictEqual([
      'Request changes',
      'Approve this version',
    ]);
    for (const button of controls) {
      expect(button.getAttribute('data-version-id')).toBe('v-2');
      expect(button.getAttribute('data-gate-id')).toBe('g-2');
    }
    expect(page.find('[data-decide="reject"]')).toBeNull();
    await page.unmount();
  });

  it('names the one effect as a team-only comment on the gate itself', async () => {
    const { client } = server([version('v-2', 2, pending('g-2'))]);
    const page = await open(client);
    await tick();

    const notice = page.find('[data-decide="controls"] [data-gate="notice"]');
    expect(notice?.textContent).toContain('changes nothing outside the app');
    expect(notice?.textContent).toContain('team-only comment');
    await page.unmount();
  });

  it('sends request_changes through the same decide as approve, on the displayed version', async () => {
    const { client, decided } = server([version('v-2', 2, pending('g-2'))]);
    const page = await open(client);
    await tick();

    await page.click('[data-decide="request_changes"]');
    await tick();

    expect(decided).toHaveLength(1);
    expect(decided[0]?.['decision']).toBe('request_changes');
    expect(decided[0]?.['versionId']).toBe('v-2');
    expect(decided[0]?.['gateId']).toBe('g-2');
    await page.unmount();
  });
});

describe('T2g the gate on the task page', () => {
  it('reads a gate on a version that is no longer the newest as stale, with approve disabled', async () => {
    const { client, decided } = server([
      version('v-3', 3, null),
      version('v-2', 2, pending('g-2')),
    ]);
    const page = await open(client);
    await tick();

    const stale = page.find('[data-version-id="v-2"] [data-gate-state]');
    expect(stale?.getAttribute('data-gate-state')).toBe('stale');
    expect(stale?.textContent).toContain('Gate stale');
    expect(page.find('[data-version-id="v-2"] [data-gate="stale"]')?.textContent).toContain(
      'A stale gate cannot be approved',
    );
    const approve = page.find('[data-version-id="v-2"] [data-decide="approve"]');
    expect(approve?.hasAttribute('disabled')).toBe(true);

    await page.click('[data-version-id="v-2"] [data-decide="approve"]');
    await tick();
    expect(decided).toHaveLength(0);
    await page.unmount();
  });
});
