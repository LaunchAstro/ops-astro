// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A plan conversation reopened shows the model kept with it, and a switch of
// model after the first question is marked in the transcript (#2175).

/* eslint-disable require-await -- Sol's proof's client double, kept as written */
import { afterEach, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';
const ID = '55555555-5555-4555-8555-555555555555';
const LOCAL = 'qwen3.6:35b-mlx';
const PLAN = 'gpt-6.1-luna';
afterEach(() => {
  unmountAll();
  sessionStorage.clear();
});
// oxlint-disable-next-line max-lines-per-function -- the proof's client double, kept as written
async function view(kept: boolean) {
  if (kept)
    sessionStorage.setItem(
      'ops-astro:drawer-tabs:sol2194',
      JSON.stringify({ selected: ID, tabs: [ID] }),
    );
  const client = {
    read: async (name: string) => {
      if (name === 'conversation.models')
        return {
          ok: true,
          value: {
            ok: true,
            chosen: kept ? PLAN : null,
            models: [
              { id: LOCAL, provider: 'ollama', reach: 'local', ceilingMinor: 0 },
              { id: PLAN, provider: 'chatgpt_plan', reach: 'cloud', ceilingMinor: 0 },
            ],
          },
        };
      if (name === 'conversation.read')
        return {
          ok: true,
          value: {
            ok: true,
            conversation: { id: ID, title: 'Kept plan chat', scope: null },
            messages: [],
          },
        };
      return { unavailable: true, because: 'not used in this proof' };
    },
    mutate: async () => ({
      ok: true,
      value: {
        recordId: '',
        revision: 0,
        detail: { conversationId: ID },
        reply: { answered: true, body: 'A local answer.', cites: [] },
      },
    }),
  } as unknown as OperationsClient;
  const page = track(
    await mount(
      <AssistantView
        client={client}
        route="agency:settings"
        here="/settings"
        entry={null}
        grantKey="sol2194"
        onClose={() => {}}
      />,
    ),
  );
  await settle();
  return page;
}
it('reopening a plan conversation displays its kept model', async () => {
  const page = await view(true);
  expect((page.find('[data-assistant="model"]') as HTMLSelectElement).value).toBe(PLAN);
});
it('switching an existing conversation to the plan marks the transcript', async () => {
  const page = await view(false);
  await page.type('[data-assistant="input"]', 'A typed local question');
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
  await page.choose('[data-assistant="model"]', PLAN);
  await settle();
  expect(page.find('[role="log"]')?.textContent).toContain(PLAN);
});
