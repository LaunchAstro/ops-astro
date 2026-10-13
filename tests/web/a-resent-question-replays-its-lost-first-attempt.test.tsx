// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A question whose answer was lost after the server committed it is resent
// under the identity it first went with, so the server's register replays the
// first attempt: one conversation, one message, never a second model call.
// A refusal or an answer ends that identity; a changed question gets its own.
// The production client runs over a stand-in API that keeps a register, as
// the server's does, and can drop an answer after committing it.

import { afterEach, expect, it } from 'vitest';
import { askDrawer, taskAsk } from '../../apps/web/src/assistant/asks.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { press, track, unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Synthetic brief',
  clientId: null,
};

/** A JSON answer, as the API sends one. */
const answer = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface Sent {
  readonly command: string;
  readonly operationId: string;
  readonly body: string;
}

/**
 * The stand-in API. Each write is committed once per operation id and its
 * first answer kept; `drop` names the commands whose first commit loses its
 * answer, and `refuse` those refused (and registered) the first time.
 */
function standIn(options: { drop?: readonly string[]; refuse?: readonly string[] } = {}) {
  const register = new Map<string, Response>();
  const sent: Sent[] = [];
  const committed: string[] = [];
  const once = { drop: new Set(options.drop), refuse: new Set(options.refuse) };
  const fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const command = String(url).split('/').slice(-2).join('.');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (command === 'conversation.models') return answer({ models: [{ id: 'model-a' }] });
    if (command === 'task.read') return answer({ task: { ...TASK, revision: 7 } });
    const operationId = body['operationId'];
    if (typeof operationId !== 'string')
      return answer({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
    sent.push({ command, operationId, body: String(body['body'] ?? '') });
    const kept = register.get(operationId);
    if (kept !== undefined) return kept.clone();
    if (once.refuse.delete(command)) {
      const refused = answer(
        { refused: true, code: 'MODEL_UNAVAILABLE', names: [], fixes: [] },
        409,
      );
      register.set(operationId, refused.clone());
      return refused;
    }
    committed.push(command);
    const conversationId = `c0000000-0000-4000-8000-00000000000${String(committed.length)}`;
    const reply = { answered: true, words: 'An answer.', cites: [] };
    const applied = answer({
      recordId: conversationId,
      revision: 1,
      detail: { conversationId },
      reply,
    });
    register.set(operationId, applied.clone());
    if (once.drop.delete(command)) throw new TypeError('The connection closed before the answer.');
    return applied;
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent, committed };
}

async function ask(client: OperationsClient, ...questions: string[]) {
  askDrawer(taskAsk(TASK), 'resend-proof');
  const page = track(
    await mount(
      <AssistantView
        grantKey="resend-proof"
        client={client}
        route="agency:task-detail"
        here="/task/T-12"
        entry={null}
        onClose={() => {}}
      />,
    ),
  );
  await settle();
  for (const question of questions) {
    // Each question in turn, as a person retypes it after a failure.
    // oxlint-disable-next-line no-await-in-loop -- one question after another
    await page.type('[data-assistant="input"]', question);
    // oxlint-disable-next-line no-await-in-loop -- one question after another
    await press(page, '[data-assistant="input"]', 'Enter');
    // oxlint-disable-next-line no-await-in-loop -- one question after another
    await settle();
    // oxlint-disable-next-line no-await-in-loop -- one question after another
    await settle();
  }
}

const identities = (sent: readonly Sent[], command: string): string[] =>
  sent.filter((one) => one.command === command).map((one) => one.operationId);

it('a first question resent after its start answer was lost replays the start: one conversation', async () => {
  const api = standIn({ drop: ['conversation.start'] });
  await ask(api.client, 'What is due today?', 'What is due today?');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBe(starts[0]);
  expect(api.committed).toEqual(['conversation.start']);
});

it('a later question resent after its answer was lost replays the message: one message', async () => {
  const api = standIn({ drop: ['conversation.message'] });
  await ask(api.client, 'First question', 'Second question', 'Second question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).toBe(messages[0]);
  expect(api.committed).toEqual(['conversation.start', 'conversation.message']);
});

it('a question refused, then resent, goes again under a fresh identity', async () => {
  const api = standIn({ refuse: ['conversation.start'] });
  await ask(api.client, 'What is due today?', 'What is due today?');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[1]).not.toBe(starts[0]);
  expect(api.committed).toEqual(['conversation.start']);
});

it('a changed question after a lost answer goes under a fresh identity', async () => {
  const api = standIn({ drop: ['conversation.message'] });
  await ask(api.client, 'First question', 'Second question', 'A different question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).not.toBe(messages[0]);
});

it('the same question asked again after its answer came goes under a fresh identity', async () => {
  const api = standIn();
  await ask(api.client, 'First question', 'Again', 'Again');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).not.toBe(messages[0]);
});
