// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #1467 in the assistant drawer, against the real server and the replay
// stand-in: a task page added before the first question rides in that first
// question, so its first model request carries the page; and a page that
// cannot be read is refused with no model asked, and the drawer no longer
// claims it was read into context.
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
  'unsupported page must not retain a claim it was read',
  async () => {
    const { page, ask } = await view('/board');
    await page.click('[data-assistant="add-page"]');
    await ask('What is on this board?');
    expect(JSON.parse(model.provider.seen.at(-1)!.body).fields.page).toBeUndefined();
    expect(page.text()).not.toContain('Read this page into context');
  },
);
