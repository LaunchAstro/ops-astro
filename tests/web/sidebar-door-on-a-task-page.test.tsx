// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 sidebar door: on a task's page the agent sidebar draws the correction
// door itself, finding the file through `live_correction.locate` for that task
// and the page address the person typed, and asks nothing of its host. On any
// other page it draws no door. A page the read does not find sends no request.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { ABOUT_FILE, askFor } from './sidebar-corrections-support.tsx';

afterEach(unmountAll);

const ASK = { page: ABOUT_FILE.pageUrl, word: 'alongside', replacement: 'beside' };

/** One business's API: the locate read finds the About file or nothing, and every call is kept. */
function business(found: boolean) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const path = at.slice(at.indexOf('/api/b/alpha') + '/api/b/alpha'.length);
    calls.push({ path, body });
    if (path === '/live_correction/locate' && found) {
      return Promise.resolve(json({ ok: true, target: ABOUT_FILE }));
    }
    if (path === '/live_correction/request') {
      const detail = { correctionId: 'c-1', state: 'requested' };
      return Promise.resolve(json({ recordId: 'c-1', revision: 1, detail }));
    }
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, calls };
}

const sent = (calls: ReturnType<typeof business>['calls'], path: string) =>
  calls.filter((call) => call.path === path).map(({ body: { operationId: _o, ...rest } }) => rest);

describe('the sidebar door on a task’s page', () => {
  it('finds the file through the site read for that task and requests the one word', async () => {
    const { client, calls } = business(true);
    const view = await mount(
      <AssistantView client={client} route="agency:task-detail" here="/task/T-12" entry={null} />,
    );
    await tick();
    expect(view.find('[data-assistant="corrections"] [data-correction-door]')).not.toBeNull();
    await askFor(view, ASK);
    expect(sent(calls, '/live_correction/locate')).toStrictEqual([
      { recordId: 'T-12', pageUrl: ABOUT_FILE.pageUrl },
    ]);
    expect(sent(calls, '/live_correction/request')).toStrictEqual([
      {
        ...ABOUT_FILE,
        word: 'alongside',
        replacement: 'beside',
        after: '# About\n\nWe work beside the teams who run your website.\n',
      },
    ]);
  });

  it('names the task by its key alone when the address carries a query or a fragment', async () => {
    const { client, calls } = business(true);
    const view = await mount(
      <AssistantView
        client={client}
        route="agency:task-detail"
        here="/task/T-12?tab=history#notes"
        entry={null}
      />,
    );
    await tick();
    await askFor(view, ASK);
    expect(sent(calls, '/live_correction/locate')).toStrictEqual([
      { recordId: 'T-12', pageUrl: ABOUT_FILE.pageUrl },
    ]);
  });

  it('sends no request for a page the site read does not find', async () => {
    const { client, calls } = business(false);
    const view = await mount(
      <AssistantView client={client} route="agency:task-detail" here="/task/T-12" entry={null} />,
    );
    await tick();
    await askFor(view, ASK);
    expect(sent(calls, '/live_correction/locate')).toHaveLength(1);
    expect(sent(calls, '/live_correction/request')).toStrictEqual([]);
  });

  it('draws no door away from a task’s page', async () => {
    const { client, calls } = business(true);
    const view = await mount(
      <AssistantView client={client} route="agency:projects-board" here="/projects" entry={null} />,
    );
    await tick();
    expect(view.find('[data-assistant="corrections"]')).toBeNull();
    expect(sent(calls, '/live_correction/locate')).toStrictEqual([]);
  });
});
