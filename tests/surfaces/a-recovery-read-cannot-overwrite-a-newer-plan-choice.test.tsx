// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A side-chat recovery read that waits while a newer model is chosen (#2175): its stale answer never
// overwrites the picker, which names the model the next question goes to. Sol's proof from PR #2194
// (S2194-11), body kept as written.

/* eslint-disable require-await -- Sol's proof's client double, kept as written */
import { afterEach, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

const ID = '55555555-5555-4555-8555-555555555555';
const LOCAL = 'qwen3.6:35b-mlx';
const LUNA = 'gpt-6.1-luna';
const SOL = 'gpt-6.1-sol';
afterEach(unmountAll);
const models = [
  { id: LOCAL, provider: 'ollama', reach: 'local', ceilingMinor: 0 },
  { id: LUNA, provider: 'chatgpt_plan', reach: 'cloud', ceilingMinor: 0 },
  { id: SOL, provider: 'chatgpt_plan', reach: 'cloud', ceilingMinor: 0 },
];
const offer = (chosen: string) => ({ ok: true, value: { ok: true, chosen, models } });
async function ask(page: Mounted, body: string) {
  await page.type('[data-assistant="input"]', body);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

// oxlint-disable-next-line max-lines-per-function -- the proof's client double, kept as written
it('Sol proof, criterion 1: a recovery read cannot overwrite a newer accepted plan choice', async () => {
  let kept = LOCAL;
  let lost = false;
  let readsSinceLoss = 0;
  let recovered = false;
  let finishRead!: (answer: ReturnType<typeof offer>) => void;
  const recovery = new Promise<ReturnType<typeof offer>>((resolve) => {
    finishRead = resolve;
  });
  const questions: { body: string; model: string }[] = [];
  const client = {
    read: async (name: string) => {
      if (name !== 'conversation.models') return { unavailable: true, because: 'not used here' };
      if (lost && !recovered) {
        if (readsSinceLoss++ === 0)
          return { unavailable: true, because: 'Read-back is unavailable.' };
        return await recovery;
      }
      return offer(kept);
    },
    mutate: async (name: string, body: Record<string, unknown>) => {
      if (name === 'conversation.set_model') {
        if (body['model'] === LUNA) {
          // The request never reached the server; LOCAL is still kept.
          lost = true;
          return { unavailable: true, because: 'Switch response lost.' };
        }
        kept = String(body['model']);
      }
      if (name === 'conversation.start' || name === 'conversation.message')
        questions.push({ body: String(body['body']), model: kept });
      return { ok: true, value: { recordId: '', revision: 0, detail: { conversationId: ID } } };
    },
  } as unknown as OperationsClient;
  const page = track(
    await mount(
      <AssistantView client={client} route="agency:settings" here="/settings" entry={null} />,
    ),
  );
  await settle();
  await page.choose('[data-assistant="model"]', LOCAL);
  await ask(page, 'First local question');
  await page.choose('[data-assistant="model"]', LUNA);
  await settle();
  await ask(page, 'Wait for the recovery read');
  // A later choice is queued behind the question while its recovery read is outstanding.
  await page.choose('[data-assistant="model"]', SOL);
  recovered = true;
  finishRead(offer(LOCAL));
  await settle();
  await ask(page, 'A question after the accepted Sol switch');
  expect(questions.at(-1)).toEqual({
    body: 'A question after the accepted Sol switch',
    model: SOL,
  });
  expect((page.find('[data-assistant="model"]') as HTMLSelectElement).value).toBe(SOL);
});
