// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A side-chat model switch shows only what the server kept (#2175): its line waits for the
// server, comes before any question asked while it waited, and a refusal puts the old model back.
// Sol's proofs from PR #2194, bodies kept as written.

/* eslint-disable require-await -- Sol's proof's client double, kept as written */
import { afterEach, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

const ID = '55555555-5555-4555-8555-555555555555';
const LOCAL = 'qwen3.6:35b-mlx';
const PLAN = 'gpt-6.1-luna';
const MARKER = `Switched to ${PLAN}. Questions from here go to it.`;
const ok = () => ({
  ok: true,
  value: { recordId: '', revision: 0, detail: { conversationId: ID } },
});
afterEach(unmountAll);

async function ask(page: Mounted, words: string) {
  await page.type('[data-assistant="input"]', words);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

// oxlint-disable-next-line max-lines-per-function -- the proof's client double, kept as written
async function fixture() {
  let finish!: (accepted: boolean) => void;
  const accepted = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  let kept = LOCAL;
  const questions: { body: string; model: string }[] = [];
  const client = {
    read: async (name: string) =>
      name === 'conversation.models'
        ? {
            ok: true,
            value: {
              ok: true,
              chosen: kept,
              models: [
                { id: LOCAL, provider: 'ollama', reach: 'local', ceilingMinor: 0 },
                { id: PLAN, provider: 'chatgpt_plan', reach: 'cloud', ceilingMinor: 0 },
              ],
            },
          }
        : { unavailable: true, because: 'not used here' },
    mutate: async (name: string, body: Record<string, unknown>) => {
      if (name === 'conversation.set_model') {
        if (!(await accepted))
          return {
            refused: true,
            code: 'FIELD_VALUE_INVALID',
            names: ['model'],
            fixes: ['Model no longer offered.'],
          };
        kept = String(body['model']);
      }
      if (name === 'conversation.start' || name === 'conversation.message')
        questions.push({ body: String(body['body']), model: kept });
      return ok();
    },
  } as unknown as OperationsClient;
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
  await page.choose('[data-assistant="model"]', LOCAL);
  await ask(page, 'First local question');
  return { page, finish, questions };
}

it('no switch line shows until the server accepts the switch', async () => {
  const { page, finish } = await fixture();
  await page.choose('[data-assistant="model"]', PLAN);
  await settle();
  expect(page.find('[role="log"]')?.textContent).not.toContain(MARKER);
  finish(true);
  await settle();
  expect(page.find('[role="log"]')?.textContent).toContain(MARKER);
});

it('a refused switch keeps the old model shown in the picker', async () => {
  const { page, finish, questions } = await fixture();
  await page.choose('[data-assistant="model"]', PLAN);
  finish(false);
  await settle();
  expect(page.find('[role="log"]')?.textContent).toContain('FIELD_VALUE_INVALID');
  await ask(page, 'Still local after refusal');
  expect(questions.at(-1)).toEqual({ body: 'Still local after refusal', model: LOCAL });
  expect((page.find('[data-assistant="model"]') as HTMLSelectElement).value).toBe(LOCAL);
  expect(page.find('[role="log"]')?.textContent).not.toContain(MARKER);
});

it('a refused switch leaves no switch line', async () => {
  const { page, finish } = await fixture();
  await page.choose('[data-assistant="model"]', PLAN);
  finish(false);
  await settle();
  expect(page.find('[role="log"]')?.textContent).toContain('FIELD_VALUE_INVALID');
  expect(page.find('[role="log"]')?.textContent).not.toContain(MARKER);
});

it('an accepted switch line comes before a question asked while it waited', async () => {
  const { page, finish, questions } = await fixture();
  await page.choose('[data-assistant="model"]', PLAN);
  await ask(page, 'Queued plan question');
  expect(questions).toHaveLength(1);
  finish(true);
  await settle();
  expect(questions.at(-1)).toEqual({ body: 'Queued plan question', model: PLAN });
  const transcript = page.find('[role="log"]')?.textContent ?? '';
  expect(transcript).toContain(MARKER);
  expect(transcript.indexOf(MARKER)).toBeLessThan(transcript.indexOf('Queued plan question'));
});
