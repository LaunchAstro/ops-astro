// SPDX-License-Identifier: AGPL-3.0-only
//
// The drawer over a stand-in register, for the proofs that a question keeps
// one operation per send. Each write is held until the test answers it. The
// register keys a write by its operation id and whole body as the server's
// does: the same id and body replays the first answer, another body is
// refused OPERATION_ID_REUSED. An answer is kept and delivered, kept and lost
// (lost after commit), or lost before anything is kept.

import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { press, track } from '../surfaces/mp-7-11-drawer-fixtures.tsx';

export const LOST = { unavailable: true, because: 'The network dropped the answer.' };
export const MODELS = [
  { id: 'replay-1', provider: 'replay', reach: 'local', ceilingMinor: 500 },
  { id: 'replay-2', provider: 'replay', reach: 'local', ceilingMinor: 500 },
];

export interface Call {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly operationId: string;
  readonly deliver: (result: unknown) => void;
}

export type Answer = 'kept' | 'lost' | 'lost before commit';

/** A conversation id the register hands its `n`th kept start. */
const conversation = (n: number): string =>
  `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

const ok = (value: Readonly<Record<string, unknown>>) => ({
  ok: true,
  value: { recordId: '', revision: 0, ...value },
});

const REUSED = {
  ok: false,
  refused: true,
  code: 'OPERATION_ID_REUSED',
  names: [],
  fixes: ['OPERATION_ID_REUSED'],
};

/** What the register keeps for `call`; a start opens the `n`th conversation. */
function outcome(call: Call, n: number): unknown {
  const words = call.body['body'] as string;
  const reply = { answered: true, messageId: `m-${call.operationId}`, body: `To ${words}` };
  if (call.name === 'conversation.start') {
    return ok({ detail: { conversationId: conversation(n) }, reply });
  }
  return ok(call.name === 'conversation.message' ? { reply } : {});
}

/** A client whose reads answer at once and whose every write waits in `calls`. */
function heldClient(calls: Call[]) {
  let minted = 0;
  const newOperationId = (): string => `op-${String((minted += 1))}`;
  return {
    newOperationId,
    read: async (name: string) =>
      await Promise.resolve(
        name === 'conversation.models'
          ? { ok: true, value: { ok: true, models: MODELS, chosen: null } }
          : { unavailable: true, because: 'not asked here' },
      ),
    mutate: async (
      name: string,
      body: Readonly<Record<string, unknown>>,
      options?: { readonly operationId?: string },
    ) =>
      await new Promise((deliver) => {
        calls.push({ name, body, operationId: options?.operationId ?? newOperationId(), deliver });
      }),
  };
}

export function attemptWire() {
  const calls: Call[] = [];
  const register = new Map<
    string,
    { readonly name: string; readonly digest: string; readonly result: unknown }
  >();
  /** Answer the `at`th write as `how`, then let the drawer settle. */
  const answer = async (at: number, how: Answer = 'kept'): Promise<void> => {
    const call = calls[at];
    if (call === undefined) throw new Error(`no write ${String(at)} was sent`);
    const digest = JSON.stringify([call.name, call.body]);
    const seen = register.get(call.operationId);
    let result = seen === undefined ? undefined : seen.digest === digest ? seen.result : REUSED;
    if (result === undefined && how !== 'lost before commit') {
      const opened = [...register.values()].filter((each) => each.name === 'conversation.start');
      result = outcome(call, opened.length + 1);
      register.set(call.operationId, { name: call.name, digest, result });
    }
    call.deliver(how === 'kept' ? result : LOST);
    for (let turn = 0; turn < 8; turn += 1) {
      // eslint-disable-next-line no-await-in-loop -- each turn lets one chained step land
      await settle();
    }
  };
  return {
    client: heldClient(calls) as unknown as OperationsClient,
    calls,
    answer,
    /** How many writes of `name` the register kept: the durable effects. */
    kept: (name: string): number =>
      [...register.values()].filter((each) => each.name === name).length,
  };
}

export async function openDrawer(
  client: OperationsClient,
  grantKey = 'grant-ada',
): Promise<Mounted> {
  const page = track(
    await mount(
      <AssistantView
        client={client}
        grantKey={grantKey}
        route="agency:settings"
        here="/settings"
        entry={null}
        onClose={() => {}}
      />,
    ),
  );
  await settle();
  return page;
}

export async function ask(page: Mounted, text: string): Promise<void> {
  await page.type('[data-assistant="input"]', text);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

/** The transcript as drawn: each line's role and its words (their own span, where one is drawn). */
export const lines = (page: Mounted): string[] =>
  page.all('[data-message-role]').map((each) => {
    const words = each.querySelector('.aip__body') ?? each;
    return `${(each as HTMLElement).dataset['messageRole'] ?? ''}: ${words.textContent ?? ''}`;
  });

/** The Send again controls the drawer offers, in order. */
export const sendAgain = (page: Mounted): HTMLButtonElement[] =>
  page.all('[data-assistant="send-again"]') as HTMLButtonElement[];
