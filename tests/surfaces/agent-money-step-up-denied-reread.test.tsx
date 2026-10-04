// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// OW-085.4's other side: the page is kept under a reread only while the
// step-up prompt is open, and never over a denial. A reread the server refuses
// draws the refusal, and the prompt and the task go with the page.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { mount, type Mounted } from './mount.tsx';
import { lineage } from './mp-6-1-agent-fixtures.tsx';

const ID = '22222222-2222-4222-8222-222222222222';
const pages: Mounted[] = [];
afterEach(async () => {
  // eslint-disable-next-line no-await-in-loop
  for (const page of pages.splice(0)) await page.unmount();
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error('the expected page did not arrive');
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

const stop = {
  askId: 'ask-1',
  runId: 'run-1',
  number: 1,
  kind: 'stop',
  ceilingMinor: 400,
  spentMinor: 390,
  currency: 'AUD',
  raisedAt: '2026-10-01T00:00:00Z',
  answer: null,
  awaitingSecond: null,
};
const task = {
  id: ID,
  key: 'TSK-2',
  title: 'Review task',
  description: null,
  state: null,
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  history: [],
  steps: [],
  alerts: [],
  comments: [],
  proposals: [lineage()],
  ledger: { envelopes: [], stops: [stop] },
};
const refusal = (code: string, fixes: readonly string[]) => ({
  refused: true,
  code,
  names: [],
  fixes,
});

/** The first read answers; a later one waits for `release`, then is refused as a revoked grant is. */
function client() {
  let reads = 0;
  const gate: { open?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  const fetch: typeof globalThis.fetch = async (url) => {
    const at = String(url);
    if (at.endsWith('/task/read')) {
      reads += 1;
      if (reads === 1) return json({ ok: true, task });
      await held;
      return json(refusal('SCOPE_NOT_GRANTED', ['Ask for the task scope.']), 403);
    }
    if (at.endsWith('/run/top_up'))
      return json(refusal('STEP_UP_REQUIRED', ['A money action needs the second factor.']), 403);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/preference/read')) return json({ ok: true, preferences: {} });
    return json(refusal('NOT_FOUND', []), 404);
  };
  return {
    client: new OperationsClient({ origin: '', businessKey: 'b', signedIn: true, fetch }),
    reads: () => reads,
    release: () => gate.open?.(),
  };
}

it('a denied reread under an open step-up prompt draws the refusal, not the kept page', async () => {
  const api = client();
  const page = await mount(
    <StepUpContext.Provider value={async () => await Promise.resolve({ ok: true, sessionId: 's' })}>
      <TaskDetailScreen client={api.client} grantKey="b:ana" taskKey={ID} />
    </StepUpContext.Provider>,
  );
  pages.push(page);
  await until(() => page.find('[data-task]') !== null);
  await page.click('[data-tabs="perspective"] [role="tab"]:nth-of-type(2)');
  await page.type('[data-section="agent"] [data-stop="amount"]', '2.50');
  await page.click('[data-section="agent"] [data-stop="top-up"]');

  // The prompt is kept on the page while the reread is out.
  await until(() => api.reads() >= 2 && page.find('[data-outcome="loading"]') !== null);
  expect(page.find('[data-step-up="prompt"]')).not.toBeNull();

  api.release();
  await until(() => page.find('[data-task]') === null);
  expect(page.find('[data-outcome="denied"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
  expect(page.find('[data-step-up="prompt"]')).toBeNull();
});
