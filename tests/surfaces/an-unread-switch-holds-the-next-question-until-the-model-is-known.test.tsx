// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A side-chat model switch whose answer and read-back are both lost (#2175): the next question
// never goes to a model the picker does not show. Sol's proof from PR #2194, body kept as written.

/* eslint-disable require-await -- Sol's proof's client double, kept as written */
import { afterEach, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

const ID = '55555555-5555-4555-8555-555555555555';
const LOCAL = 'qwen3.6:35b-mlx';
const PLAN = 'gpt-6.1-luna';
afterEach(unmountAll);
async function ask(page: Mounted, body: string) {
  await page.type('[data-assistant="input"]', body);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

// oxlint-disable-next-line max-lines-per-function -- the proof's client double, kept as written
it('an unread switch never sends a question under a model the picker does not show', async () => {
  let switchAttempted = false;
  const questions: { body: string; model: string }[] = [];
  const client = {
    read: async (name: string) => {
      if (name !== 'conversation.models') return { unavailable: true, because: 'not used here' };
      if (switchAttempted) {
        return { unavailable: true, because: 'Model read is unavailable too.' };
      }
      return {
        ok: true,
        value: {
          ok: true,
          chosen: PLAN,
          models: [
            { id: LOCAL, provider: 'ollama', reach: 'local', ceilingMinor: 0 },
            { id: PLAN, provider: 'chatgpt_plan', reach: 'cloud', ceilingMinor: 0 },
          ],
        },
      };
    },
    mutate: async (name: string, body: Record<string, unknown>) => {
      if (name === 'conversation.set_model') {
        switchAttempted = true;
        // The request did not reach the server: its kept model remains PLAN.
        return { unavailable: true, because: 'The switch connection failed.' };
      }
      if (name === 'conversation.start' || name === 'conversation.message')
        questions.push({ body: String(body['body']), model: PLAN });
      return { ok: true, value: { recordId: '', revision: 0, detail: { conversationId: ID } } };
    },
  } as unknown as OperationsClient;
  const page = track(
    await mount(
      <AssistantView client={client} route="agency:settings" here="/settings" entry={null} />,
    ),
  );
  await settle();
  await page.choose('[data-assistant="model"]', PLAN);
  await ask(page, 'First plan question');
  await page.choose('[data-assistant="model"]', LOCAL);
  await settle();
  await ask(page, 'A question after the unread switch');
  expect(questions[0]?.model).toBe(PLAN);
  // Either reconcile before sending, or make the uncertainty explicit and hold the turn.
  // Naming LOCAL while this question actually uses PLAN is never truthful.
  const next = questions.find((one) => one.body === 'A question after the unread switch');
  const shown = (page.find('[data-assistant="model"]') as HTMLSelectElement).value;
  expect({ sentOnPlan: next?.model === PLAN, shownAsLocal: shown === LOCAL }).not.toEqual({
    sentOnPlan: true,
    shownAsLocal: true,
  });
});

// oxlint-disable-next-line max-lines-per-function -- the client double, as in the proof above
it('a question held by an unread switch says so, and once the model reads back the next one goes', async () => {
  let reads = 0;
  let switched = false;
  const questions: { body: string; model: string }[] = [];
  const models = [
    { id: LOCAL, provider: 'ollama', reach: 'local', ceilingMinor: 0 },
    { id: PLAN, provider: 'chatgpt_plan', reach: 'cloud', ceilingMinor: 0 },
  ];
  const client = {
    read: async (name: string) => {
      if (name !== 'conversation.models') return { unavailable: true, because: 'not used here' };
      // Unavailable twice after the switch (its own read-back, then the held question's).
      if (switched && reads++ < 2) return { unavailable: true, because: 'Model read is down.' };
      return { ok: true, value: { ok: true, chosen: PLAN, models } };
    },
    mutate: async (name: string, body: Record<string, unknown>) => {
      if (name === 'conversation.set_model') {
        switched = true;
        return { unavailable: true, because: 'The switch connection failed.' };
      }
      if (name === 'conversation.start' || name === 'conversation.message')
        questions.push({ body: String(body['body']), model: PLAN });
      return { ok: true, value: { recordId: '', revision: 0, detail: { conversationId: ID } } };
    },
  } as unknown as OperationsClient;
  const page = track(
    await mount(
      <AssistantView client={client} route="agency:settings" here="/settings" entry={null} />,
    ),
  );
  await settle();
  await page.choose('[data-assistant="model"]', PLAN);
  await ask(page, 'First plan question');
  await page.choose('[data-assistant="model"]', LOCAL);
  await settle();
  await ask(page, 'Held while the model is unread');
  expect(questions.map((one) => one.body)).toEqual(['First plan question']);
  expect(page.find('[role="log"]')?.textContent).toContain('Not sent');
  await ask(page, 'Asked once it reads back');
  expect(questions.at(-1)).toEqual({ body: 'Asked once it reads back', model: PLAN });
  expect((page.find('[data-assistant="model"]') as HTMLSelectElement).value).toBe(PLAN);
});
