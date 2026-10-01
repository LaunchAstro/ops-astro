// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-13's Create (CS-4.37, DN-03, DN-05): the task first, then every part
// on the draft by its own command, the client only from the page's scope, one
// create per attempt; and the close that stops this person's running timer
// (TR-S-PI6-4). The draft itself is mp-4-13-draft.test.tsx.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';
import { Host, NEW_ID, NEW_KEY, create, draft, fill, server, store } from './draft-support.tsx';

afterEach(unmountAll);

describe('MP-4-13 CS-4.37 Create writes a real task', () => {
  it('the task first, then every field and part chosen on the draft, each by its own command', async () => {
    const { client, sent } = server();
    const storage = store();
    const { view, outcome } = await draft({
      client,
      storage,
      scope: { clientId: 'c-client-a', from: 'Client A' },
    });
    await fill(view);
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual([
      '/task/create',
      '/task/set_party',
      '/task/comment',
      '/tag/list',
      '/task/add_tag',
      '/tag/create',
      '/task/add_tag',
      '/task/create',
      '/time/log',
    ]);
    expect(sent[0]?.body).toMatchObject({
      fields: { title: 'New brief', due: '2026-10-09', estimated_minutes: 60 },
      board: null,
    });
    expect(sent[1]?.body).toMatchObject({
      recordId: NEW_ID,
      fields: { client: 'c-client-a' },
      expectedRevision: 1,
    });
    expect(sent[2]?.body).toMatchObject({
      recordId: NEW_ID,
      body: 'From the kickoff call.',
      audience: 'internal',
      commentType: 'note',
      expectedRevision: 2,
    });
    expect(sent[4]?.body).toMatchObject({ recordId: NEW_ID, tagId: 'g-legal' });
    expect(sent[5]?.body).toMatchObject({ name: 'Launch' });
    expect(sent[6]?.body).toMatchObject({ recordId: NEW_ID, tagId: 'g-new' });
    expect(sent[7]?.body).toMatchObject({ fields: { title: 'Call the client' }, parentId: NEW_ID });
    expect(sent[8]?.body).toMatchObject({ taskId: NEW_ID, duration: '30m' });
    expect(outcome.created).toBe(NEW_KEY);
    expect(storage.length).toBe(0);
  });
});

describe('MP-4-13 CS-4.37 the client, the list and the retry', () => {
  it('the client comes from the page’s scope, or is left empty: never a fixed client', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'No client here');
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual(['/task/create']);
    expect(sent[0]?.body['fields']).toStrictEqual({ title: 'No client here' });
  });

  it('Create works whether or not any task list has been opened first', async () => {
    const { client, sent } = server();
    const { view, outcome } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'First thing today');
    await create(view);
    expect(sent.some((one) => one.to === '/task/board')).toBe(false);
    expect(outcome.created).toBe(NEW_KEY);
  });

  it('a part refused after the task exists is named, and the task is not created twice', async () => {
    const { client, sent } = server(['/task/add_tag']);
    const storage = store();
    const { view, outcome } = await draft({ client, storage });
    await typeInto(view, '#panel-draft-name', 'New brief');
    await typeInto(view, '#panel-draft-tags', 'Legal');
    await press(view, '#panel-draft-tags', 'Enter');
    await create(view);
    expect(view.find('[data-draft-missed]')?.textContent).toContain('the tag Legal');
    expect(outcome.created).toBeNull();
    expect(storage.length).toBe(0);
    await view.click('[data-draft="open-created"]');
    expect(outcome.created).toBe(NEW_KEY);
    expect(sent.filter((one) => one.to === '/task/create')).toHaveLength(1);
  });

  it('an unknown outcome keeps the create’s identity, so the retry cannot make a second task', async () => {
    const { client, sent } = server([], 1);
    const { view, outcome } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'New brief');
    await create(view);
    expect(outcome.created).toBeNull();
    await create(view);
    const creates = sent.filter((one) => one.to === '/task/create');
    expect(creates).toHaveLength(2);
    expect(creates[1]?.body['operationId']).toBe(creates[0]?.body['operationId']);
    expect(outcome.created).toBe(NEW_KEY);
  });
});

describe('MP-4-13 close stops the running timer', () => {
  const RUNNING = {
    time: {
      entries: [],
      running: { entryId: 'e-1', startedAt: '2026-09-30T08:00:00Z' },
      totalMinutes: 0,
    },
  };

  it('the panel hands its host a stop while this person’s timer runs on its task', async () => {
    const { client, sent } = serving(RUNNING);
    const leaving: { stop: (() => void) | null } = { stop: null };
    await panel(client, {
      leaving: (stop) => {
        leaving.stop = stop;
      },
    });
    expect(leaving.stop).not.toBeNull();
    await act(async () => {
      leaving.stop?.();
      await Promise.resolve();
    });
    expect(sent.map((one) => [one.to, one.body['taskId']])).toStrictEqual([
      ['/time/stop', TASK_ID],
    ]);
  });

  it('no timer running on the task: nothing to stop', async () => {
    const { client } = serving();
    const leaving: { stop: (() => void) | null } = {
      stop: () => {
        /* armed before the read */
      },
    };
    await panel(client, {
      leaving: (stop) => {
        leaving.stop = stop;
      },
    });
    expect(leaving.stop).toBeNull();
  });
});

describe('MP-4-13 close stops the running timer: the host', () => {
  it('the host runs the stop on X, on opening another task and on a new draft, never twice', async () => {
    const stops: string[] = [];
    const view = await mount(<Host onStop={(why) => stops.push(why)} />);
    await tick();
    for (const [button, why] of [
      ['close', 'close'],
      ['other', 'other'],
      ['draft', 'draft'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one gesture at a time
      await view.click(`[data-host="arm-${why}"]`);
      // eslint-disable-next-line no-await-in-loop -- one gesture at a time
      await view.click(`[data-host="${button}"]`);
    }
    await view.click('[data-host="close"]');
    expect(stops).toStrictEqual(['close', 'other', 'draft']);
  });
});
