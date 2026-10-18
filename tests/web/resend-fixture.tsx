// SPDX-License-Identifier: AGPL-3.0-only
//
// The assistant drawer over a stand-in API that keeps a register as the
// server's does: a repeated operation id answers what its first attempt
// committed. Shared by the resend suites (`apps/web/src/assistant/resend.ts`).

import { askDrawer, taskAsk } from '../../apps/web/src/assistant/asks.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { press, track } from '../surfaces/mp-7-11-drawer-fixtures.tsx';

export const TASK = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Synthetic brief',
  clientId: null,
};

/** What the stand-in does with a write: answer it, lose its answer, hold it, or refuse it. */
type Turn = 'answer' | 'drop' | 'hold' | 'refuse';

export interface Sent {
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

/** The task revision each read answers, and the reply each committed write carries. */
export interface Shape {
  readonly revision: () => number;
  readonly reply: () => unknown;
}

const PLAIN: Shape = {
  revision: () => 7,
  reply: () => ({ answered: true, words: 'An answer.', cites: [] }),
};

/** How the stand-in answers one request, by its turns. */
function responder({ register, sent, committed, held, queues }: Stage, { revision, reply }: Shape) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const command = String(url).split('/').slice(-2).join('.');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (command === 'conversation.models') return answer({ models: [{ id: 'model-a' }] });
    if (command === 'task.read') return answer({ task: { ...TASK, revision: revision() } });
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
    const applied = answer({
      recordId: conversationId,
      revision: 1,
      detail: { conversationId },
      reply: reply(),
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
export function standIn(
  first: Readonly<Record<string, Turn[]>> = {},
  replay: Readonly<Record<string, ('answer' | 'refuse')[]>> = {},
  shape: Partial<Shape> = {},
) {
  const register = new Map<string, Response>();
  const sent: Sent[] = [];
  const committed: string[] = [];
  const held: (() => void)[] = [];
  const queues = {
    first: new Map(Object.entries(first).map(([k, v]) => [k, [...v]])),
    replay: new Map(Object.entries(replay).map(([k, v]) => [k, [...v]])),
  };
  const respond = responder({ register, sent, committed, held, queues }, { ...PLAIN, ...shape });
  const fetch = ((url: string, init?: RequestInit) =>
    respond(url, init)) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent, committed, release: () => held.shift()?.() };
}

/** The drawer open on a task, and a way to ask in it as a person types. */
export async function drawer(client: OperationsClient) {
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

export const identities = (sent: readonly Sent[], command: string): string[] =>
  sent.filter((one) => one.command === command).map((one) => one.operationId);
