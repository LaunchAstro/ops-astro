// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A plan reply (AW-04's card) lands beside the question it answers, as any
// other reply does: a later question asked while the plan was on its way does
// not push the card below itself.

import { afterEach, expect, it } from 'vitest';
import type { PlanOffer } from '../../packages/core-wire/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '33333333-3333-4333-8333-333333333333';

const offer: PlanOffer = {
  gateId: '66666666-6666-4666-8666-666666666666',
  versionId: '77777777-7777-4777-8777-777777777771',
  version: 1,
  task: { id: '55555555-5555-4555-8555-555555555555', key: 'T-12', title: 'Spring brief' },
  text: 'Draft the brief. Ceiling: $10.00.',
  steps: [{ key: 'draft', title: 'Draft the brief', after: [] }],
  ceilingMinor: 1000,
  currency: 'AUD',
  planningSpendMinor: 12,
  entryPath: 'agents/brief.md',
  paths: [],
};

const answer = (reply: Record<string, unknown>): Response =>
  Response.json({ recordId: '', revision: 0, detail: { conversationId: CONVERSATION }, reply });

/** An answer held back until the test lets it go. */
function gate(): { readonly held: Promise<void>; readonly release: () => void } {
  const released: (() => void)[] = [];
  const held = new Promise<void>((resolve) => {
    released.push(resolve);
  });
  return {
    held,
    release: () => {
      for (const resolve of released) resolve();
    },
  };
}

async function ask(page: Mounted, body: string): Promise<void> {
  await page.type('[data-assistant="input"]', body);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

it('a plan reply stays beside its question when a later one is asked first', async () => {
  const { held, release } = gate();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (path.endsWith('/conversation/allowance')) return Response.json({}, { status: 503 });
    if (body['body'] === 'Plan it') {
      await held;
      return answer({
        answered: true,
        messageId: 'm-plan',
        body: 'Here is the plan.',
        plan: offer,
      });
    }
    return answer({ answered: true, messageId: crypto.randomUUID(), body: 'Reply' });
  };
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
  });
  const page = track(
    await mount(
      <AssistantView client={client} route="agency:settings" here="/settings" entry={null} />,
    ),
  );
  await ask(page, 'Start');
  await ask(page, 'Plan it');
  await ask(page, 'Later question');
  release();
  await settle();
  await settle();
  const roles = page
    .all('[data-message-role]')
    .map((line) => (line instanceof HTMLElement ? line.dataset['messageRole'] : null));
  expect(roles).toEqual(['user', 'ai', 'user', 'plan', 'user', 'ai']);
  expect(page.all('[data-message-role]')[3]?.textContent).toContain('Here is the plan.');
});
