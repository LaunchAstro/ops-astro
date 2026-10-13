// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A question whose answer was lost after the server may have committed it is
// resent under the identity and the request it first went with, so the
// server's register replays the first attempt. Only a success of that same
// identity ends it: not a refusal of a replay, and not another send's answer
// arriving late. A question refused on its own first answer, a changed one,
// or one asked again after its answer, goes afresh. The production client
// runs the real send path over a stand-in API; this proves the identities
// sent, and the real-register suite proves the rows.

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

/** What the stand-in does with a write: answer it, lose its answer, hold it, or refuse it. */
type Turn = 'answer' | 'drop' | 'hold' | 'refuse';

interface Sent {
  readonly command: string;
  readonly operationId: string;
}

/** A JSON answer, as the API sends one. */
const answer = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const refusal = (): Response =>
  answer({ refused: true, code: 'MODEL_UNAVAILABLE', names: [], fixes: [] }, 409);

/** The stand-in's state, shared between its responder and the test. */
interface Stage {
  readonly register: Map<string, Response>;
  readonly sent: Sent[];
  readonly committed: string[];
  readonly held: (() => void)[];
  readonly queues: {
    readonly first: Map<string, Turn[]>;
    readonly replay: Map<string, ('answer' | 'refuse')[]>;
  };
}

/** How the stand-in answers one request, by its turns. */
function responder({ register, sent, committed, held, queues }: Stage) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const command = String(url).split('/').slice(-2).join('.');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (command === 'conversation.models') return answer({ models: [{ id: 'model-a' }] });
    if (command === 'task.read') return answer({ task: { ...TASK, revision: 7 } });
    const operationId = body['operationId'];
    if (typeof operationId !== 'string') {
      return answer({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
    }
    sent.push({ command, operationId });
    const kept = register.get(operationId);
    if (kept !== undefined) {
      return queues.replay.get(command)?.shift() === 'refuse' ? refusal() : kept.clone();
    }
    const turn = queues.first.get(command)?.shift() ?? 'answer';
    if (turn === 'refuse') {
      register.set(operationId, refusal());
      return refusal();
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
    if (turn === 'drop') throw new TypeError('The connection closed before the answer.');
    if (turn === 'hold')
      await new Promise<void>((release) => {
        held.push(release);
      });
    return applied;
  };
}

/**
 * The stand-in API. A new operation id takes the next of its command's
 * `first` turns (answer by default) and, unless refused, is committed and its
 * answer kept; a repeat takes the next `replay` turn, answering what was kept
 * by default. A held write is committed and answers on `release()`.
 */
function standIn(
  first: Readonly<Record<string, Turn[]>> = {},
  replay: Readonly<Record<string, ('answer' | 'refuse')[]>> = {},
) {
  const register = new Map<string, Response>();
  const sent: Sent[] = [];
  const committed: string[] = [];
  const held: (() => void)[] = [];
  const queues = {
    first: new Map(Object.entries(first).map(([k, v]) => [k, [...v]])),
    replay: new Map(Object.entries(replay).map(([k, v]) => [k, [...v]])),
  };
  const respond = responder({ register, sent, committed, held, queues });
  const fetch = ((url: string, init?: RequestInit) =>
    respond(url, init)) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent, committed, release: () => held.shift()?.() };
}

/** The drawer open on a task, and a way to ask in it as a person types. */
async function drawer(client: OperationsClient) {
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
  return async (...questions: string[]): Promise<void> => {
    for (const question of questions) {
      // oxlint-disable-next-line no-await-in-loop -- one question after another, as typed
      await page.type('[data-assistant="input"]', question);
      // oxlint-disable-next-line no-await-in-loop -- one question after another, as typed
      await press(page, '[data-assistant="input"]', 'Enter');
      // oxlint-disable-next-line no-await-in-loop -- one question after another, as typed
      await settle();
      // oxlint-disable-next-line no-await-in-loop -- one question after another, as typed
      await settle();
    }
  };
}

const identities = (sent: readonly Sent[], command: string): string[] =>
  sent.filter((one) => one.command === command).map((one) => one.operationId);

it('a first question resent after its start answer was lost replays the start: one conversation', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  await (
    await drawer(api.client)
  )('What is due today?', 'What is due today?');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBe(starts[0]);
  expect(api.committed).toEqual(['conversation.start']);
});

it('a later question resent after its answer was lost replays the message: one message', async () => {
  const api = standIn({ 'conversation.message': ['drop'] });
  await (
    await drawer(api.client)
  )('First question', 'Second question', 'Second question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).toBe(messages[0]);
  expect(api.committed).toEqual(['conversation.start', 'conversation.message']);
});

it('a resend refused after a lost answer keeps the identity, and the next resend replays the first attempt', async () => {
  const api = standIn({ 'conversation.start': ['drop'] }, { 'conversation.start': ['refuse'] });
  const question = 'What is due today?';
  await (
    await drawer(api.client)
  )(question, question, question);
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(3);
  expect(new Set(starts).size).toBe(1);
  expect(api.committed).toEqual(['conversation.start']);
});

it('an older answer arriving late never clears a newer lost question', async () => {
  const api = standIn({ 'conversation.message': ['hold', 'drop'] });
  const ask = await drawer(api.client);
  await ask('First question', 'Second question', 'Third question');
  api.release();
  await settle();
  await ask('Third question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(3);
  expect(messages[2]).toBe(messages[1]);
  expect(api.committed).toEqual([
    'conversation.start',
    'conversation.message',
    'conversation.message',
  ]);
});

it('a question refused on its own first answer, then resent, goes again under a fresh identity', async () => {
  const api = standIn({ 'conversation.start': ['refuse'] });
  await (
    await drawer(api.client)
  )('What is due today?', 'What is due today?');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toHaveLength(2);
  expect(starts[1]).not.toBe(starts[0]);
});

it('a changed question after a lost answer goes under a fresh identity', async () => {
  const api = standIn({ 'conversation.message': ['drop'] });
  await (
    await drawer(api.client)
  )('First question', 'Second question', 'A different question');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).not.toBe(messages[0]);
});

it('the same question asked again after its answer came goes under a fresh identity', async () => {
  const api = standIn();
  await (
    await drawer(api.client)
  )('First question', 'Again', 'Again');
  const messages = identities(api.sent, 'conversation.message');
  expect(messages).toHaveLength(2);
  expect(messages[1]).not.toBe(messages[0]);
});
