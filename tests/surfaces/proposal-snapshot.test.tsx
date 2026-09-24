// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The decision controls follow the one state a proposal read answers (P2 at
// 3eddfbe).
//
// The page offers approve and reject from the gate state `task.read` returns.
// A read that answered `pending` beside an already verified `approve` drew
// enabled controls for a gate nobody may decide again. The correction is in
// the read, not the page: these cases take the projection the real
// `readTaskProposals` returns while a real `task.decide` commits before or
// after its snapshot, hand it to the production client and screen as the
// server would, and read what the screen offers.
//
// - Decide before the snapshot: the answer is the decided view, and the page
//   draws no decision control, only the reason it is closed.
// - Decide after the snapshot: the answer is wholly pending, and the page
//   offers enabled controls. Pressing one would meet the server's typed
//   refusal; that path is `task-proposals.test.tsx`'s.

import { randomUUID } from 'node:crypto';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  type ProposalView,
  readTaskProposals,
} from '../../packages/core-records/src/reads/proposals.ts';
import { connect, type TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';
import { mount } from './mount.tsx';

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let flush = 0; flush < 3; flush += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

interface Proposed {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
}

async function pending(world: World): Promise<Proposed> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `controls follow the read ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);
  const revision = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, taskId],
  );
  const proposed = await asAda(world, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: Number(revision[0]?.revision ?? '0'),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;
  return { taskId, gateId: String(detail['gateId']), versionId: String(detail['versionId']) };
}

/**
 * The real projection, with a real approve committed before the read's first
 * statement or after it.
 */
async function projectionAround(
  world: World,
  gate: Proposed,
  when: 'before' | 'after',
): Promise<readonly ProposalView[]> {
  const approve = async (): Promise<void> => {
    const answer = await asAda(world, '/task/decide', {
      operationId: randomUUID(),
      gateId: gate.gateId,
      versionId: gate.versionId,
      decision: 'approve',
      note: 'approve around the read',
    });
    expect(answer.code, 'decide').toBe('ok');
  };
  const reader = connect(world.db.appUrl, { source: 'runtime' });
  try {
    return await reader.withBusiness(world.alpha, async (tx) => {
      let count = 0;
      const wrapped: TenantQuery = {
        businessId: tx.businessId,
        async query<Row>(text: string, parameters?: readonly unknown[]) {
          if (when === 'before' && count === 0) await approve();
          const rows = await tx.query<Row>(text, parameters);
          count += 1;
          if (when === 'after' && count === 1) await approve();
          return rows;
        },
      };
      return await readTaskProposals(wrapped, gate.taskId, {
        id: process.env['GATE_SIGNING_KEY_ID'] ?? '',
        secret: process.env['GATE_SIGNING_SECRET'] ?? '',
      });
    });
  } finally {
    await reader.close();
  }
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** The production client, answering `task.read` with the projection, as JSON. */
function clientServing(taskId: string, proposals: readonly ProposalView[]): OperationsClient {
  const task = {
    id: taskId,
    key: 'TSK-1',
    title: 'A task with one proposal',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 2,
    history: [],
    comments: [],
    proposals: JSON.parse(JSON.stringify(proposals)) as unknown,
  };
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    return new Response(
      JSON.stringify({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }),
      {
        status: 404,
      },
    );
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
}

describe.skipIf(serverUrl === undefined)('decision controls from one coherent read', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it('draws no decision control for the decided view and enabled ones for the pending view', async () => {
    world = await createWorld('psnapui');
    const current = world;

    const decided = await pending(current);
    const decidedView = await projectionAround(current, decided, 'before');
    const approved = decidedView[0]?.versions[0]?.gate;
    expect(approved?.state).toBe('approved');
    expect(decidedView[0]?.decisions.map((row) => [row.decision, row.round])).toEqual([
      ['approve', approved?.round],
    ]);
    const shut = await mount(
      <TaskDetailScreen
        client={clientServing(decided.taskId, decidedView)}
        grantKey="alpha:ada"
        taskKey="TSK-1"
      />,
    );
    await tick();
    expect(shut.find('[data-gate-state]')?.getAttribute('data-gate-state')).toBe('approved');
    expect(shut.find('[data-decide="approve"]')).toBeNull();
    expect(shut.find('[data-decide="reject"]')).toBeNull();
    expect(shut.find('[data-decide="closed"]')?.textContent).toContain('approved');
    await shut.unmount();

    const open = await pending(current);
    const pendingView = await projectionAround(current, open, 'after');
    expect(pendingView[0]?.versions[0]?.gate?.state).toBe('pending');
    expect(pendingView[0]?.decisions).toEqual([]);
    const offered = await mount(
      <TaskDetailScreen
        client={clientServing(open.taskId, pendingView)}
        grantKey="alpha:ada"
        taskKey="TSK-1"
      />,
    );
    await tick();
    expect(offered.find('[data-gate-state]')?.getAttribute('data-gate-state')).toBe('pending');
    const approve = offered.find('[data-decide="approve"]');
    expect(approve).not.toBeNull();
    expect(approve?.hasAttribute('disabled')).toBe(false);
    expect(approve?.getAttribute('data-gate-id')).toBe(open.gateId);
    expect(approve?.getAttribute('data-version-id')).toBe(open.versionId);
    expect(offered.find('[data-decide="reject"]')?.hasAttribute('disabled')).toBe(false);
    expect(offered.find('[data-decide="closed"]')).toBeNull();
    await offered.unmount();
  }, 120_000);
});
