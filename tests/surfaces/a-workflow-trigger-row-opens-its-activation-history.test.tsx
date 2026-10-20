// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers: each activation row opens its history
// (`automation.history`), newest first, drawn with the shared kit's table and
// chips. The page words each outcome code (`no_standing_approval` reads "Not
// approved for this version"), names who made each change and the run an
// occurrence started, and asks for the next page with the cursor the last one
// gave. A refused read is shown as it came. The server is a stub that keeps
// what it was sent.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TriggersPanel } from '../../apps/web/src/screens/settings/triggers.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- let the answers land in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const REGISTRY = {
  ok: true,
  definitions: [
    {
      id: 'd-1',
      kind: 'automation',
      name: 'Weekly report',
      versions: [
        {
          id: 'v-1',
          number: 1,
          contentDigest: 'a'.repeat(64),
          contentSize: 10,
          modes: ['manual', 'scheduled'],
          releasedBy: 'p-1',
          releasedAt: '2026-09-28T00:00:00.000Z',
        },
      ],
      activations: [
        {
          id: 'a-1',
          versionId: 'v-1',
          versionNumber: 1,
          mode: 'scheduled',
          everyMinutes: 60,
          eventKind: null,
          enabled: false,
          changedBy: 'p-1',
          changedAt: '2026-09-29T00:00:00.000Z',
          revision: 3,
          approval: null,
        },
      ],
    },
  ],
};

const FIRST = {
  ok: true,
  entries: [
    {
      kind: 'change',
      id: 'e-3',
      at: '2026-10-05T09:30:00.000Z',
      command: 'activation.turn_off',
      actorId: 'ac-1',
      actorKind: 'person',
      actorName: 'Nathan Mulligan',
    },
    {
      kind: 'occurrence',
      id: 'o-2',
      at: '2026-10-05T09:00:00.000Z',
      cause: { kind: 'scheduled', dueAt: '2026-10-05T09:00:00.000Z' },
      outcome: 'no_standing_approval',
      dispatch: null,
      runId: null,
    },
    {
      kind: 'occurrence',
      id: 'o-1',
      at: '2026-10-05T08:00:00.000Z',
      cause: { kind: 'event' },
      outcome: 'approved',
      dispatch: 'started',
      runId: 'run-0001-abcd',
    },
  ],
  next: 'cursor-2',
};

const OLDER = {
  ok: true,
  entries: [
    {
      kind: 'change',
      id: 'e-1',
      at: '2026-10-01T01:00:00.000Z',
      command: 'activation.adopt',
      actorId: 'ac-2',
      actorKind: 'person',
      actorName: 'Mia Alpha',
    },
  ],
  next: null,
};

function server(options: { readonly refuse?: boolean } = {}) {
  const asked: Record<string, unknown>[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/automation/registry')) return await Promise.resolve(json(REGISTRY));
    if (at.endsWith('/automation/history')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      asked.push(body);
      if (options.refuse === true) {
        return json(
          { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['Ask an owner.'] },
          403,
        );
      }
      return json(body['cursor'] === 'cursor-2' ? OLDER : FIRST);
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const clientOf = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });

const HISTORY = '[data-history="a-1"]';

/** The entries drawn, in order, by the id each row's time carries. */
const entries = (page: Awaited<ReturnType<typeof mount>>): (string | null)[] =>
  page
    .all(`${HISTORY} tbody tr`)
    .map((row) => row.querySelector<HTMLElement>('[data-entry]')?.dataset['entry'] ?? null);

// eslint-disable-next-line max-lines-per-function -- one stub, the cases that share it
describe('an activation history on Workflow triggers', () => {
  it('opens from its row, newest first, with each outcome worded, each actor named and the run shown', async () => {
    const stub = server();
    const page = await mount(<TriggersPanel client={clientOf(stub.fetch)} />);
    await tick();
    expect(page.find(`${HISTORY}`)).toBeNull();
    await page.click('[data-activation="a-1"] [data-control="history"]');
    await tick();
    expect(stub.asked.map(({ activationId, cursor }) => [activationId, cursor])).toStrictEqual([
      ['a-1', undefined],
    ]);
    const rows = page.all(`${HISTORY} tbody tr`);
    expect(entries(page)).toStrictEqual(['e-3', 'o-2', 'o-1']);
    expect(rows[0]?.textContent).toContain('Turned off');
    expect(rows[0]?.textContent).toContain('Nathan Mulligan');
    expect(rows[1]?.textContent).toContain('Not approved for this version');
    expect(rows[1]?.textContent).toContain('Due');
    expect(rows[2]?.textContent).toContain('An event');
    expect(rows[2]?.textContent).toContain('run-0001');
    expect(page.find(`${HISTORY} table`)?.className).toBe('table table--dense');
    expect(page.all(`${HISTORY} .chip`)).toHaveLength(2);
    await page.unmount();
  });

  it('asks for older entries with the cursor the last page gave, until none is left', async () => {
    const stub = server();
    const page = await mount(<TriggersPanel client={clientOf(stub.fetch)} />);
    await tick();
    await page.click('[data-activation="a-1"] [data-control="history"]');
    await tick();
    await page.click(`${HISTORY} [data-control="history-older"]`);
    await tick();
    expect(stub.asked.map(({ cursor }) => cursor)).toStrictEqual([undefined, 'cursor-2']);
    expect(entries(page)).toStrictEqual(['e-3', 'o-2', 'o-1', 'e-1']);
    expect(page.find(`${HISTORY} [data-entry="e-1"]`)?.closest('tr')?.textContent).toContain(
      'Adopted a version',
    );
    expect(page.find(`${HISTORY} [data-control="history-older"]`)).toBeNull();
    await page.click('[data-activation="a-1"] [data-control="history"]');
    expect(page.find(`${HISTORY}`)).toBeNull();
    await page.unmount();
  });

  it('shows a refused history read as it came, and no entry', async () => {
    const page = await mount(<TriggersPanel client={clientOf(server({ refuse: true }).fetch)} />);
    await tick();
    await page.click('[data-activation="a-1"] [data-control="history"]');
    await tick();
    expect(page.find(`${HISTORY}`)?.textContent).toContain('Ask an owner.');
    expect(page.all(`${HISTORY} tbody tr`)).toHaveLength(0);
    await page.unmount();
  });
});
