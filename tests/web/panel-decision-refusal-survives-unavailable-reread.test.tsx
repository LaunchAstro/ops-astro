// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision refused for want of the grant, in the dock task panel's Agent
// side, closes that gate's controls for as long as the task's panel is open.
// A reread that answers unavailable unmounts the panel's body; the refusal is
// held above the read, so when the next read answers, Approve and Reject are
// still closed rather than drawn live again until the server refuses again.
// The server stays the authority; this is what the panel offers.

import type { ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { DIGEST, lineage, version } from '../surfaces/mp-6-1-agent-fixtures.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { KEY, PANE } from './task-panel-agent-support.tsx';
import { task, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const ignore = (): void => {
  /* The case reads nothing from this call. */
};

const GATE = { id: 'g-1', state: 'pending', round: 1, expiresAt: null, expired: false };

/** One task with a pending gate; every decision refused for want of the grant. */
function server() {
  let reads: 'ok' | 'unavailable' = 'ok';
  const decided: string[] = [];
  const over = {
    proposals: [
      lineage({
        versions: [version({ versionId: 'v-1', gate: { ...GATE, payloadDigest: DIGEST } })],
      }),
    ],
  };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/task/read')) {
      return Promise.resolve(
        reads === 'ok' ? json({ ok: true, task: task(over) }) : new Response(null, { status: 503 }),
      );
    }
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/decide')) {
      decided.push(String(init?.body ?? ''));
      return Promise.resolve(
        json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
      );
    }
    if (where.endsWith('/preference/read')) {
      return Promise.resolve(json({ ok: true, preferences: {} }));
    }
    if (where.endsWith('/client/list')) return Promise.resolve(json({ ok: true, clients: [] }));
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (/\/live(\/task\/|\?|$)/u.test(where)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(json({ ok: false }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    decided,
    answer: (next: 'ok' | 'unavailable') => {
      reads = next;
    },
  };
}

const panel = (client: OperationsClient, changes: number): ReactElement => (
  <StepUpContext.Provider
    value={() => Promise.resolve({ ok: false, because: 'Not here.' } as const)}
  >
    <TaskPanel
      client={client}
      grantKey="alpha:member"
      opening={{ taskKey: KEY, door: 'open', tab: null }}
      changes={changes}
      onChanged={ignore}
      onClose={ignore}
    />
  </StepUpContext.Provider>
);

it('a refused decision stays closed through a reread that answers unavailable', async () => {
  const api = server();
  const view = await mount(panel(api.client, 0));
  await tick();
  await view.click('#panel-perspective-tab-agent');
  await tick();
  await view.click(`${PANE} [data-gate-action="approve"]`);
  await tick();
  expect(api.decided).toHaveLength(1);
  expect(view.find(`${PANE} [data-gate-action="approve"]`)).toBeNull();
  expect(view.find(`${PANE} [data-gate="closed"]`)).not.toBeNull();

  api.answer('unavailable');
  await view.render(panel(api.client, 1));
  await tick();
  expect(view.find(`${PANE}`)).toBeNull();

  api.answer('ok');
  await view.render(panel(api.client, 2));
  await tick();
  expect(view.find(`${PANE}`)).not.toBeNull();
  expect(view.find(`${PANE} [data-gate-action="approve"]`)).toBeNull();
  expect(view.find(`${PANE} [data-gate="closed"]`)).not.toBeNull();
});
