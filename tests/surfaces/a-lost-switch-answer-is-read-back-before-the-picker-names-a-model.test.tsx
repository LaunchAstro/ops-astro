// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A side-chat model switch whose answer is lost in transport (#2175): the server kept it, so the
// picker never shows the old model while questions go to the new one. Sol's proof from PR #2194,
// body kept as written.

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

it('a lost switch answer never shows the old model while questions go to the new one', async () => {
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
        // The server commits the choice, but its response is lost in transport.
        kept = String(body['model']);
        return { unavailable: true, because: 'The connection closed before the response arrived.' };
      }
      if (name === 'conversation.start' || name === 'conversation.message')
        questions.push({ body: String(body['body']), model: kept });
      return { ok: true, value: { recordId: '', revision: 0, detail: { conversationId: ID } } };
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
  await page.choose('[data-assistant="model"]', PLAN);
  await settle();
  expect(page.find('[role="log"]')?.textContent).toContain('The connection closed');
  await ask(page, 'Which model gets this after the lost response?');
  expect(questions.at(-1)?.model).toBe(PLAN);
  expect((page.find('[data-assistant="model"]') as HTMLSelectElement).value).toBe(PLAN);
});
