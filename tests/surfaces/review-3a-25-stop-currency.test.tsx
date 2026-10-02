// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-3A-25 (weak test): C54's top-up test claims the amount is sent "in
// the ask's currency", but its ask, envelope and version are all AUD
// (`c54-page.tsx`), so a pane sending the envelope's or the head's currency
// passes it too. Here the ask is NZD while the version (the head) and the
// task's envelope are AUD; the top-up must name NZD. The real TaskDetailScreen
// and OperationsClient over a stand-in at HTTP, as `c54-page.tsx` does, with
// an AUD envelope on the read's ledger.

import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';
import { IN_PANE, TASK_ID, press, tick, type } from './c54-page.tsx';

const RUN_ID = '88888888-8888-4888-8888-888888888888';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const task = {
  id: TASK_ID,
  key: 'TSK-54',
  title: 'A task stopped at its ceiling',
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
    {
      lineageId: 'l-54',
      state: 'live',
      versions: [
        {
          versionId: 'v-54',
          version: 1,
          purpose: 'send_the_reply',
          maximumMinor: 1_800,
          currency: 'AUD',
          payloadDigest: 'digest-54',
          payload: {},
          supersededAt: null,
          runId: RUN_ID,
          checks: [],
          evidence: null,
          gate: {
            id: 'g-54',
            state: 'approved',
            round: 0,
            expiresAt: '2026-10-01T00:00:00.000Z',
            expired: false,
            payloadDigest: 'digest-54',
          },
        },
      ],
      decisions: [],
      reservations: [
        {
          id: 'res-54',
          envelopeId: 'env-54',
          runId: RUN_ID,
          state: 'held',
          heldMinor: 1_800,
          actualMinor: null,
          classifiedCause: null,
          lease: { state: 'live' },
          attempt: { id: '77777777-7777-4777-8777-777777777777', state: 'settled' },
        },
      ],
    },
  ],
  ledger: {
    envelopes: [
      {
        id: 'env-54',
        state: 'open',
        maximumMinor: 1_800,
        heldMinor: 1_800,
        actualMinor: 0,
        currency: 'AUD',
        openedAt: '2026-09-29T01:00:00.000Z',
        closedAt: null,
        openedBy: { versionId: 'v-54' },
        cap: { key: 'agent_work', limitMinor: 100_000, currency: 'AUD' },
      },
    ],
    stops: [
      {
        askId: 'ask-1',
        runId: RUN_ID,
        number: 1,
        kind: 'stop',
        ceilingMinor: 400,
        spentMinor: 390,
        currency: 'NZD',
        raisedAt: '2026-09-30T01:00:00.000Z',
        answer: null,
        awaitingSecond: null,
      },
    ],
  },
};

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function open() {
  const sent: { readonly route: string; readonly body: Record<string, unknown> }[] = [];
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    if (at.endsWith('/run/top_up')) {
      sent.push({ route: 'run/top_up', body: JSON.parse(String(init?.body ?? '{}')) });
      return json({ ok: true, recordId: TASK_ID, detail: {} });
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
    newOperationId: () => 'operation-54',
  });
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-54" />,
  );
  live.push(page);
  await tick();
  return { page, sent };
}

describe('REVIEW-3A-25 the top-up at a stop names the ask’s currency', () => {
  it('REVIEW-3A-25: an NZD ask on an AUD envelope and AUD version sends the top-up in NZD', async () => {
    const { page, sent } = await open();
    // The stop is drawn in its own currency, beside the AUD allowance.
    expect(page.find(`${IN_PANE} [data-agent="budget-stop"]`)?.textContent).toContain(
      'Top up by (NZD)',
    );
    expect(page.find('[data-tokens="allowance"]')?.textContent).toContain('AUD');
    await type(page, '[data-stop="amount"]', '2.50');
    await press(page, '[data-stop="top-up"]');
    expect(sent).toStrictEqual([
      {
        route: 'run/top_up',
        body: {
          operationId: 'operation-54',
          recordId: TASK_ID,
          runId: RUN_ID,
          // The top-up is bound to the ask it answers (REVIEW-3A-7).
          askId: 'ask-1',
          amountMinor: 250,
          currency: 'NZD',
        },
      },
    ]);
  });
});
