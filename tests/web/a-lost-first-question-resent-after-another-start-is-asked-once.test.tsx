// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #897: a first question whose start committed but lost its answer, then a
// different question that starts the tab, then the first question resent
// unchanged. The resend replays the first start's identity, so the rows keep
// one question, one reply and one provider send per question asked. Drives
// the production drawer and client over the real API, its register, the
// conversation exchange and a loopback provider on migrated Postgres. Moved
// from the review's proof with its body unchanged but its grant key's name.
import { afterEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { conversationWorld, type ConversationWorld } from '../api/aw-03-fixture.ts';
import { composedWith, localModel, type LocalModel } from '../api/aw-03-exchange-fixture.ts';
import { createApiFixture, authorised, tokenFor } from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: ConversationWorld | undefined;
let model: LocalModel | undefined;
afterEach(async () => {
  await unmountAll();
  await model?.close();
  await w?.drop();
});

async function setup() {
  model = await localModel();
  const fixture = await createApiFixture('resend897');
  w = await conversationWorld({ fixture, api: composedWith(fixture, model.exchange) });
  const signedIn = authorised(await tokenFor(w.owner.presented.subject));
  const lose: string[] = [];
  let completed = 0;
  const sent: { command: string; operationId: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const command = url.split('/').slice(-2).join('.');
    const body = JSON.parse(String(init?.body));
    sent.push({ command, operationId: body.operationId });
    const response = await w!.api.fetch(
      new Request(`http://api.test${url}`, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), ...signedIn },
      }),
    );
    const text = await response.text();
    const at = lose.indexOf(command);
    if (at >= 0) {
      lose.splice(at, 1);
      completed += 1;
      throw new TypeError('The connection closed before the answer.');
    }
    if (command === 'conversation.start' || command === 'conversation.message') completed += 1;
    return new Response(text, { status: response.status, headers: response.headers });
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const totals = async () => {
    const rows = await w!.fixture.db.admin.execute<{
      conversations: number;
      questions: number;
      replies: number;
      calls: number;
    }>(`
      select (select count(*)::int from conversations) as conversations,
      (select count(*)::int from conversation_messages where role='person') as questions,
      (select count(*)::int from conversation_messages where role='agent') as replies,
      (select count(*)::int from model_calls) as calls`);
    return { ...rows[0], providerSends: model!.provider.seen.length };
  };
  return { lose, sent, totals, client, completed: () => completed };
}

import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { press, track, unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';

describe.skipIf(serverUrl === undefined)('a lost first question resent after another start', () => {
  it('a lost first question resent after another question started the tab stores no second question, reply or provider send', async () => {
    const api = await setup();
    api.lose.push('conversation.start');
    const page = track(
      await mount(
        <AssistantView
          grantKey="a-lost-first-question-resent"
          client={api.client}
          route="agency:projects-board"
          here="/projects"
          entry={null}
        />,
      ),
    );
    const ask = async (body: string, at: number) => {
      await expect
        .poll(() => page.find('[data-assistant="input"]')?.hasAttribute('disabled'), {
          timeout: 10000,
        })
        .toBe(false);
      await page.type('[data-assistant="input"]', body);
      await press(page, '[data-assistant="input"]', 'Enter');
      await expect.poll(api.completed, { timeout: 10000 }).toBe(at);
      await settle();
    };
    await ask('Question A', 1);
    await ask('Question B', 2);
    expect(await api.totals()).toEqual({
      conversations: 2,
      questions: 2,
      replies: 2,
      calls: 2,
      providerSends: 2,
    });
    await ask('Question A', 3);
    expect(await api.totals()).toEqual({
      conversations: 2,
      questions: 2,
      replies: 2,
      calls: 2,
      providerSends: 2,
    });
    const writes = api.sent.filter(
      (s) => s.command === 'conversation.start' || s.command === 'conversation.message',
    );
    expect(writes[2]!.operationId).toBe(writes[0]!.operationId);
  }, 30000);
});
