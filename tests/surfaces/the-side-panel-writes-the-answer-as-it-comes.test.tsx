// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The drawer shows the agent's answer as it is written: one provisional line,
// marked as writing, that grows piece by piece and is replaced by the settled
// reply. A piece missing from the run ends the provisional text where the run
// broke ("…"), and nothing after it is shown until the settled reply comes.
// An answer that does not finish takes the provisional text away and says so.
// The operations client is a stand-in for the network; the stream itself is
// read by the real client in `tests/web/the-operations-client-reads-a-streamed-answer.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '55555555-5555-4555-8555-555555555555';

interface Piece {
  readonly seq: number;
  readonly text: string;
}

type Ending = { readonly reply: Record<string, unknown> } | 'unfinished';

const nothing = (): void => {};

/** A client whose start streams `pieces`, then waits for `finish` before it answers. */
function streamingClient(pieces: readonly Piece[]) {
  let finish: (ending: Ending) => void = nothing;
  const ended = new Promise<Ending>((resolve) => {
    finish = resolve;
  });
  const client = {
    read: async () => await Promise.resolve({ unavailable: true, because: 'not asked here' }),
    mutate: async (
      name: string,
      _body: unknown,
      options?: { readonly onPiece?: (piece: Piece) => void },
    ) => {
      if (name !== 'conversation.start') {
        return { ok: true, value: { recordId: '', revision: 0, detail: {} } };
      }
      for (const piece of pieces) options?.onPiece?.(piece);
      const ending = await ended;
      if (ending === 'unfinished')
        return { unavailable: true, because: 'The answer did not finish.' };
      return {
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION }, ...ending },
      };
    },
  } as unknown as OperationsClient;
  return { client, finish };
}

async function asked(client: OperationsClient) {
  const page = track(
    await mount(
      <AssistantView
        client={client}
        route="agency:settings"
        here="/settings"
        entry={null}
        onClose={() => {}}
      />,
    ),
  );
  await settle();
  await page.type('[data-assistant="input"]', 'What is due?');
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
  return page;
}

const answers = (page: Awaited<ReturnType<typeof asked>>) =>
  page.all('[data-message-role="ai"]').map((line) => ({
    text: line.textContent,
    writing: (line as HTMLElement).dataset['writing'] !== undefined,
  }));

const SETTLED = {
  reply: { answered: true, messageId: 'm-9', body: 'Two tasks are due.', cites: [] },
};

describe('the side panel writes the answer as it comes', () => {
  it('shows one provisional line growing piece by piece, then the settled reply in its place', async () => {
    const { client, finish } = streamingClient([
      { seq: 0, text: 'Two ' },
      { seq: 1, text: 'tasks ' },
    ]);
    const page = await asked(client);
    expect(answers(page)).toStrictEqual([{ text: 'Two tasks ', writing: true }]);
    finish(SETTLED);
    await settle();
    expect(answers(page)).toStrictEqual([{ text: 'Two tasks are due.', writing: false }]);
  });

  it('a missing piece ends the provisional text where the run broke', async () => {
    const { client, finish } = streamingClient([
      { seq: 0, text: 'Two ' },
      { seq: 1, text: 'tasks ' },
      { seq: 3, text: 'due ' },
      { seq: 4, text: 'today.' },
    ]);
    const page = await asked(client);
    expect(answers(page)).toStrictEqual([{ text: 'Two tasks …', writing: true }]);
    finish(SETTLED);
    await settle();
    expect(answers(page)).toStrictEqual([{ text: 'Two tasks are due.', writing: false }]);
  });

  it('an answer that does not finish takes the provisional text away and says so', async () => {
    const { client, finish } = streamingClient([{ seq: 0, text: 'Two ' }]);
    const page = await asked(client);
    finish('unfinished');
    await settle();
    expect(answers(page)).toStrictEqual([]);
    expect(page.text()).toContain('The answer did not finish.');
    expect(page.text()).not.toContain('Two ');
  });

  it('a refusal with no pieces shows only its words', async () => {
    const { client, finish } = streamingClient([]);
    const page = await asked(client);
    expect(answers(page)).toStrictEqual([]);
    finish({ reply: { answered: false, code: 'RATE_LIMITED', words: 'The model is busy.' } });
    await settle();
    expect(answers(page)).toStrictEqual([]);
    expect(page.text()).toContain('The model is busy.');
  });
});
