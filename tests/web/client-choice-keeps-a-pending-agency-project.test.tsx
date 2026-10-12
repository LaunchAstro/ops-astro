// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { prefillOf } from '../../apps/web/src/screens/task/task-prefill.ts';
import { readDraft } from '../../apps/web/src/screens/task/task-draft.ts';
import { json, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import {
  ADA,
  NEW_ID,
  NEW_KEY,
  create,
  draft,
  store,
  valueOf,
  type Sent,
} from './draft-support.tsx';

afterEach(unmountAll);

const CLIENT = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

for (const pending of [false, true]) {
  // One scenario read top to bottom.
  // eslint-disable-next-line max-lines-per-function -- the scenario reads as one
  it(`choosing a client keeps an agency project when its list is ${pending ? 'pending' : 'loaded'}`, async () => {
    const sent: Sent[] = [];
    // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced once the read starts
    let finishProjects: (response: Response) => void = () => {
      throw new Error('project read never started');
    };
    const projects = new Promise<Response>((resolve) => {
      finishProjects = resolve;
    });
    const projectAnswer = () =>
      json({
        ok: true,
        tasks: [{ id: PROJECT, title: 'Agency site', clientSet: false, client: null }],
        viewer: 'p',
        owed: 0,
      });
    // eslint-disable-next-line require-await -- answers as the API does, a promise each time
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
      sent.push({ to, body });
      if (to === '/task/board') return pending ? projects : projectAnswer();
      if (to === '/client/list')
        return json({ ok: true, clients: [{ clientId: CLIENT, name: 'Example Client' }] });
      if (to === '/task/create')
        return json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } });
      return json({ recordId: NEW_ID, revision: Number(body['expectedRevision']) + 1, detail: {} });
    };
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    const storage = store();
    const prefill = prefillOf(
      { from: 'Agency site', boardId: PROJECT, title: 'New brief' },
      new Date('2026-10-13T00:00:00Z'),
    );
    const { view, outcome } = await draft({
      client,
      storage,
      scope: { clientId: null, from: 'Agency site', prefill },
    });
    expect(valueOf(view, '#panel-draft-board')).toBe(PROJECT);
    // Use the visible control and its real menu, including the lazy client read.
    // On the base there is no client field, so the existing project remains untouched.
    if (view.find('#panel-draft-client-control') !== null) {
      await view.click('#panel-draft-client-control');
      await tick();
      expect(view.find('#panel-draft-client-control-opt-1')?.textContent).toContain(
        'Example Client',
      );
      await view.click('#panel-draft-client-control-opt-1');
    }
    if (pending) {
      await act(async () => {
        finishProjects(projectAnswer());
        await tick();
      });
    }
    // Create must retain the agency project irrespective of read completion order.
    const keptBoard = readDraft(storage, ADA)?.boardId;
    await create(view);
    expect(outcome.created).toBe(NEW_KEY);
    expect({
      keptBoard,
      board: sent.find((one) => one.to === '/task/move')?.body['board'],
    }).toEqual({ keptBoard: PROJECT, board: PROJECT });
  });
}
