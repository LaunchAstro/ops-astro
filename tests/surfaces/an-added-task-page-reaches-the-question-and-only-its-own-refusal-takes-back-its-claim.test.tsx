// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #1467 in the assistant drawer, against the real server and the replay
// stand-in: a task page added before the first question rides in that first
// question, so its first model request carries the page; and a page that
// cannot be read is refused with no model asked, and the drawer no longer
// claims it was read into context.
import { randomUUID } from 'node:crypto';
import { act } from 'react';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { conversationWorld, type ConversationWorld } from '../api/aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from '../api/aw-03-exchange-fixture.ts';
import { createApiFixture } from '../api/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

const serverUrl = databaseUrlFromEnvironment();

let w: ConversationWorld;
let model: LocalModel;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  model = await localModel();
  const fixture = await createApiFixture('page_drawer');
  w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
}, 180_000);
afterEach(unmountAll);
afterAll(async () => {
  await model?.close();
  await w?.drop();
});

async function view(
  address: string,
  beforeReturn?: (name: string, answer: unknown) => Promise<void>,
) {
  const pending: Promise<unknown>[] = [];
  const client = {
    read: () => Promise.resolve({ unavailable: true, because: 'ancillary reads not needed' }),
    mutate: (name: string, body: Record<string, unknown>) => {
      const sent = w.as(w.owner, name, body).then(async (answer) => {
        await beforeReturn?.(name, answer);
        expect(answer.status).toBe(200);
        return { ok: true, value: answer.body };
      });
      pending.push(sent);
      return sent;
    },
  } as unknown as OperationsClient;
  const page = track(
    await mount(
      <AssistantView client={client} route="agency:task-detail" here={address} entry={null} />,
    ),
  );
  const drain = async () => {
    for (let round = 0; round < 5; round++) {
      // oxlint-disable-next-line no-await-in-loop -- each round settles what the last one sent
      await act(async () => {
        await Promise.all(pending);
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await settle();
    }
  };
  const ask = async (body: string) => {
    await page.type('[data-assistant="input"]', body);
    await press(page, '[data-assistant="input"]', 'Enter');
    await drain();
  };
  return { page, ask, drain, client };
}

it.skipIf(serverUrl === undefined)(
  'Add page before the first question sends page text in the first model request',
  async () => {
    const title = `FIRST-PAGE-${randomUUID()}`;
    const made = await w.as(w.owner, 'task.create', { fields: { title } });
    expect(made.status).toBe(200);
    const id = made.body['recordId'];
    const [row] = await w.fixture.db.admin.execute<{ key: string }>(
      'select txt_1 as key from public.records where id = $1',
      [id],
    );
    const { page, ask } = await view(`/task/${row!.key}`);
    await page.click('[data-assistant="add-page"]');
    const before = model.provider.seen.length;
    await ask('What is this task about?');
    expect(model.provider.seen).toHaveLength(before + 1);
    expect(JSON.parse(model.provider.seen.at(-1)!.body).fields.page).toBe(
      JSON.stringify({ task: id, title }),
    );
    expect(page.text()).toContain(title);
    await ask('And later?');
    expect(JSON.parse(model.provider.seen.at(-1)!.body).fields.page).toContain(title);
  },
);

it.skipIf(serverUrl === undefined)(
  'an unreadable added page does not retain the read-into-context claim',
  async () => {
    const { page, ask, drain } = await view('/task/T-no-such-task');
    await ask('Start an ordinary conversation');
    await page.click('[data-assistant="add-page"]');
    await drain();
    const before = model.provider.seen.length;
    await ask('Read the missing page');
    expect(model.provider.seen).toHaveLength(before);
    expect(page.find('[data-message-role="failed"]')).not.toBeNull();
    expect(page.text()).not.toContain('Read this page into context');
  },
);

it.skipIf(serverUrl === undefined)(
  'an unreadable page before start is refused without claiming it was read',
  async () => {
    const { page, ask } = await view('/task/T-absent');
    await page.click('[data-assistant="add-page"]');
    const before = model.provider.seen.length;
    await ask('What is this task?');
    expect(model.provider.seen).toHaveLength(before);
    expect(page.text()).not.toContain('Read this page into context');
    expect(page.text()).toContain('couldn’t be read into context');
  },
);

it.skipIf(serverUrl === undefined)(
  'a late refusal for the old page does not mark the newly added readable page unreadable',
  async () => {
    const made = await w.as(w.owner, 'task.create', {
      fields: { title: 'READABLE-REPLACEMENT-PAGE' },
    });
    expect(made.status).toBe(200);
    const id = String(made.body['recordId']);
    let release!: () => void;
    let arrived!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responseReady = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let delayNext = false;
    const { page, ask, drain, client } = await view('/task/T-missing-old-page', async (name) => {
      if (delayNext && name === 'conversation.message') {
        delayNext = false;
        arrived();
        await released;
      }
    });
    await ask('Start an ordinary conversation');
    await page.click('[data-assistant="add-page"]');
    await drain();
    delayNext = true;
    await page.type('[data-assistant="input"]', 'Read the old missing page');
    await press(page, '[data-assistant="input"]', 'Enter');
    await responseReady;
    try {
      await page.render(
        <AssistantView
          client={client}
          route="agency:task-detail"
          here={`/task/${id}`}
          entry={null}
        />,
      );
      await page.click('[data-assistant="add-page"]');
    } finally {
      release();
    }
    await drain();
    await ask('Read the new page');
    expect(JSON.parse(model.provider.seen.at(-1)!.body).fields.page).toContain(
      'READABLE-REPLACEMENT-PAGE',
    );
    expect(page.text()).toContain('READABLE-REPLACEMENT-PAGE');
    expect(page.text()).not.toContain('This page couldn’t be read into context');
  },
);
