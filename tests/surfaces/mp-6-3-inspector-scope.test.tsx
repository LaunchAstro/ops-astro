// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable unicorn/prefer-dom-node-dataset -- the assertion reads its data- attribute by the DOM name */
import { expect, it } from 'vitest';
import { RunProgress } from '../../apps/web/src/views/run-progress.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';
import { tick } from './mp-6-3-fixture.tsx';

const execution = {
  outcome: 'ready',
  runs: [
    {
      runId: 'private-run',
      lineageId: 'private-lineage',
      versionId: 'private-version',
      state: 'claimed',
      taskRevisionAtRequest: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  events: [],
  complete: true,
  next: null,
  graph: {
    plan: 'bound',
    sourceRevision: 1,
    complete: true,
    steps: [
      { key: 'private-step', title: 'Client A private work', after: [], runIds: ['private-run'] },
    ],
    nodes: [
      {
        nodeId: 'private-run',
        condition: 'in_progress',
        planned: null,
        observed: {
          condition: 'in_progress',
          runState: 'claimed',
          attemptId: null,
          whoseMove: null,
          outcome: null,
          fault: 'Client A private fault',
          lease: null,
          effectObserved: false,
          heldMinor: 12345,
          spentMinor: null,
          currency: 'AUD',
        },
      },
    ],
  },
};

function client(businessKey: string, pending: boolean): OperationsClient {
  const fetch: typeof globalThis.fetch = async () =>
    pending
      ? await new Promise<Response>(() => {})
      : new Response(JSON.stringify({ ok: true, execution }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  return new OperationsClient({
    origin: '',
    businessKey,
    signedIn: true,
    fetch,
    newOperationId: () => 'sol-read-only',
  });
}

it.each([
  ['business to business', 'beta:bea', 'T-2', 'beta'],
  ['client to client', 'alpha:ada', 'CLIENT-B-TASK', 'alpha'],
  ['person to person', 'alpha:bea', 'T-1', 'alpha'],
])(
  '%s inspector data is cleared while the new scope loads',
  async (_, grantKey, taskKey, businessKey) => {
    const page = await mount(
      <RunProgress
        client={client('alpha', false)}
        grantKey="alpha:ada"
        taskKey="T-1"
        readOf={1}
        proposals={[]}
      />,
    );
    try {
      await tick();
      expect(page.find('[data-map="detail"]')?.textContent).toContain('Client A private fault');
      await page.render(
        <RunProgress
          client={client(businessKey, true)}
          grantKey={grantKey}
          taskKey={taskKey}
          readOf={2}
          proposals={[]}
        />,
      );
      await tick();
      expect(page.find('[data-run-progress]')?.getAttribute('data-outcome')).toBe('loading');
      expect(page.find('[data-map="detail"]')?.textContent ?? '').not.toContain(
        'Client A private fault',
      );
      expect(page.text()).not.toContain('AUD 123.45');
    } finally {
      await page.unmount();
    }
  },
);
