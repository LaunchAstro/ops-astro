// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { RunProgress } from '../../apps/web/src/views/run-progress.tsx';
import { mount } from './mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

it('a refused receipt read does not claim the attempt had no observed effect', async () => {
  const fetch: typeof globalThis.fetch = async (input): Promise<Response> => {
    if (String(input).endsWith('/task/execution')) {
      return json({
        ok: true,
        execution: {
          outcome: 'ready', taskId: 'task-1', sourceRevision: 1, complete: true, next: null,
          runs: [{ runId: 'run-1', lineageId: 'lineage-1', versionId: 'version-1', state: 'running', taskRevisionAtRequest: 1, createdAt: '2026-09-29T01:00:00.000Z' }],
          events: [{ eventId: 'event-1', runId: 'run-1', position: 1, kind: 'claimed', leaseId: 'lease-1', attemptId: 'attempt-1', actorId: 'agent-1', detail: {}, at: '2026-09-29T01:00:00.000Z' }],
        },
      });
    }
    if (String(input).endsWith('/task/receipt'))
      return json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const page = await mount(<RunProgress client={client} grantKey="alpha:reader" readOf={null} taskKey="TSK-1" />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const receipt = page.find('[data-receipt-attempt="attempt-1"]');
  expect(receipt).not.toBeNull();
  expect(receipt?.textContent).not.toContain('its effect has not been observed');
  await page.unmount();
});
