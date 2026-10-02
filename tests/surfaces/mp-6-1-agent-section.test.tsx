// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-1, the Agent pane as the task page mounts it: its controls go through
// the page's real client to `task.decide` and `task.cancel`, naming the exact
// gate and version the read showed, and every outcome ends in a reread. The
// server here is a stand-in for the HTTP boundary only; what the server does
// with the decision is proven against Postgres in `tests/api/mp-6-1-*`.

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

const TASK_ID = '55555555-5555-4555-8555-555555555555';

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

interface World {
  readonly gateState: 'pending' | 'approved';
  readonly running: boolean;
  /** What `task.decide` answers: accepted, or refused with this code. */
  readonly refuse: string | null;
  /** `task.read`'s token ledger (MP-6-5); absent as on a read made before it. */
  readonly ledger?: unknown;
}

function lineageOf(world: World) {
  return {
    lineageId: 'l-7',
    state: 'live',
    versions: [
      {
        versionId: 'v-7b',
        version: 2,
        purpose: 'draft_the_reply',
        maximumMinor: 2_500,
        currency: 'AUD',
        payloadDigest: 'digest-7b',
        payload: {},
        supersededAt: null,
        runId: world.running ? 'run-7' : null,
        checks: [],
        evidence: null,
        gate: {
          id: 'g-7b',
          state: world.gateState,
          round: 0,
          expiresAt: '2026-10-01T00:00:00.000Z',
          expired: false,
          payloadDigest: 'digest-7b',
        },
      },
    ],
    decisions: [],
    reservations: world.running
      ? [
          {
            id: 'res-7',
            envelopeId: 'env-7',
            runId: 'run-7',
            state: 'held',
            heldMinor: 2_500,
            actualMinor: null,
            classifiedCause: null,
            lease: { state: 'live' },
            attempt: { state: 'dispatched' },
          },
        ]
      : [],
  };
}

function server(world: World) {
  const task = {
    id: TASK_ID,
    key: 'TSK-7',
    title: 'A task the agent is working',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 4,
    history: [],
    comments: [],
    proposals: [lineageOf(world)],
    ...(world.ledger === undefined ? {} : { ledger: world.ledger }),
  };
  const sent: { readonly route: string; readonly body: Record<string, unknown> }[] = [];
  let reads = 0;
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) {
      reads += 1;
      return json({ ok: true, task });
    }
    for (const route of ['task/decide', 'task/cancel']) {
      if (at.endsWith(`/${route}`)) {
        sent.push({ route, body: JSON.parse(String(init?.body ?? '{}')) });
        return world.refuse === null
          ? json({ ok: true })
          : json({ refused: true, code: world.refuse, names: [], fixes: [] }, 409);
      }
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
    newOperationId: () => 'operation-7',
  });
  return { client, sent, reads: () => reads };
}

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function open(world: World) {
  const at = server(world);
  const page = await mount(
    <TaskDetailScreen client={at.client} grantKey="alpha:ada" taskKey="TSK-7" />,
  );
  live.push(page);
  await tick();
  return { ...at, page };
}

const IN_PANE = '[data-section="agent"]';

// eslint-disable-next-line max-lines-per-function -- one page, each control and the ledger on it
describe('MP-6-1 agent section on the task page', () => {
  it('MP-6-5 allowance composition: the task page draws its read’s ledger in the Agent pane', async () => {
    const ledger = {
      envelopes: [
        {
          id: 'env-7',
          state: 'open',
          maximumMinor: 2_500,
          heldMinor: 2_500,
          actualMinor: 0,
          currency: 'AUD',
          openedAt: '2026-09-29T01:00:00.000Z',
          closedAt: null,
          openedBy: { versionId: 'v-7b' },
          cap: { key: 'agent_work', limitMinor: 50_000, currency: 'AUD' },
        },
      ],
    };
    const { page } = await open({ gateState: 'approved', running: true, refuse: null, ledger });
    const panel = page.find(`${IN_PANE} [data-agent="tokens"]`);
    expect(panel?.getAttribute('data-tokens')).toBe('tracked');
    expect(page.find(`${IN_PANE} [data-tokens="head"]`)?.textContent).toBe('AUD 0.00 of AUD 25.00');
    expect(page.find(`${IN_PANE} [data-tokens="opened-by"]`)?.textContent).toContain('version 2');
    expect(
      page.all(`${IN_PANE} [data-token-run]`).map((row) => row.getAttribute('data-token-run')),
    ).toStrictEqual(['res-7']);
  });

  it('MP-6-5 allowance composition: a read with no ledger draws no panel', async () => {
    const { page } = await open({ gateState: 'approved', running: true, refuse: null });
    expect(page.find(`${IN_PANE} [data-agent="pane"]`)).not.toBeNull();
    expect(page.find(`${IN_PANE} [data-agent="tokens"]`)).toBeNull();
  });

  it('MP-6-1 section decides the exact version, then reads again', async () => {
    const { page, sent, reads } = await open({
      gateState: 'pending',
      running: false,
      refuse: null,
    });
    const before = reads();
    await page.click(`${IN_PANE} [data-gate-action="approve"]`);
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.route).toBe('task/decide');
    expect(sent[0]?.body).toMatchObject({ gateId: 'g-7b', versionId: 'v-7b', decision: 'approve' });
    expect(reads()).toBeGreaterThan(before);
    expect(page.find(`${IN_PANE} [data-agent="refusal"]`)).toBeNull();
  });

  it('MP-6-1 section rejects from the header through the decide path', async () => {
    const { page, sent } = await open({ gateState: 'pending', running: false, refuse: null });
    await page.click(`${IN_PANE} [data-agent="reject"]`);
    await tick();
    expect(sent.map((call) => [call.route, call.body['decision']])).toStrictEqual([
      ['task/decide', 'reject'],
    ]);
    expect(sent[0]?.body).toMatchObject({ gateId: 'g-7b', versionId: 'v-7b' });
  });

  it('MP-6-1 section cancels the run it shows, and quotes a refusal', async () => {
    const { page, sent, reads } = await open({
      gateState: 'approved',
      running: true,
      refuse: 'SCOPE_NOT_GRANTED',
    });
    const before = reads();
    await page.click(`${IN_PANE} [data-agent="cancel"]`);
    await tick();
    expect(sent.map((call) => call.route)).toStrictEqual(['task/cancel']);
    expect(sent[0]?.body).toMatchObject({ recordId: TASK_ID, lineageId: 'l-7' });
    expect(page.find(`${IN_PANE} [data-agent="refusal"]`)?.textContent).not.toBe('');
    expect(reads()).toBeGreaterThan(before);
  });
});
