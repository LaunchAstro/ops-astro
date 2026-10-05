// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// AW-04's kept operation id, against a register that behaves like the server's:
// it keys each accept by operation id and digests the whole body, so the same
// id with another body is refused OPERATION_ID_REUSED, and a gate decides once.
// A card's kept id belongs to its own body (two tabs' cards differ by their
// conversation) and to the session that clicked it.

import { afterEach, expect, it } from 'vitest';
import type { PlanOffer } from '../../packages/core-wire/src/index.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const TAB_ONE = '44444444-4444-4444-8444-444444444441';
const TAB_TWO = '44444444-4444-4444-8444-444444444442';

const OFFER: PlanOffer = {
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

const ok = (value: Readonly<Record<string, unknown>>) => ({
  ok: true,
  value: { recordId: '', revision: 0, ...value },
});
const refusal = (code: string) => ({ ok: false, refused: true, code, names: [], fixes: [code] });
const LOST = { unavailable: true, because: 'The network dropped the answer.' };

/** Each start answers the next conversation id with version 1's plan; `spent` ids hold another body. */
function registerClient(conversations: readonly string[], spent: readonly string[] = []) {
  const register = new Map<string, { readonly digest: string; readonly answer: unknown }>(
    spent.map((id) => [id, { digest: 'another body', answer: null }]),
  );
  const queue = [...conversations];
  const ids: (string | undefined)[] = [];
  let decided = false;
  let lose = false;
  let minted = 0;
  const accept = (body: unknown, id: string): unknown => {
    const digest = JSON.stringify(body);
    const seen = register.get(id);
    if (seen !== undefined)
      return seen.digest === digest ? seen.answer : refusal('OPERATION_ID_REUSED');
    const answer = decided ? refusal('GATE_ALREADY_DECIDED') : ok({ detail: { runId: 'run-1' } });
    decided = true;
    register.set(id, { digest, answer });
    return answer;
  };
  const client = {
    newOperationId: () => {
      minted += 1;
      return `op-${String(minted)}`;
    },
    read: () => Promise.resolve({ unavailable: true, because: 'not asked here' }),
    mutate: (name: string, body: unknown, options?: { readonly operationId?: string }) => {
      if (name === 'task.accept_plan') {
        ids.push(options?.operationId);
        const answer = accept(body, options?.operationId ?? '');
        const lost = lose;
        lose = false;
        return Promise.resolve(lost ? LOST : answer);
      }
      const reply = { answered: true, messageId: 'm-1', body: 'Here is the plan.', plan: OFFER };
      if (name !== 'conversation.start') return Promise.resolve(ok({}));
      return Promise.resolve(ok({ detail: { conversationId: queue.shift() }, reply }));
    },
  } as unknown as OperationsClient;
  const loseNext = (): void => {
    lose = true;
  };
  return { client, ids, loseNext, minted: () => minted };
}

async function open(client: OperationsClient, grantKey = 'grant-ada') {
  const page = await mount(
    <AssistantView
      client={client}
      grantKey={grantKey}
      route="agency:projects-board"
      here="/projects"
      entry={null}
      onClose={() => {}}
    />,
  );
  const ask = async (): Promise<void> => {
    await page.type('[data-assistant="input"]', 'Write the spring brief');
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
  };
  const accept = async (): Promise<void> => {
    await page.click('[data-plan="accept"]');
    await settle();
  };
  return { page, ask, accept };
}

it('AW04FIX4-F1 two tabs with a card for one version: a lost accept replays under its own id, and the other tab never spends it', async () => {
  const drawer = registerClient([TAB_ONE, TAB_TWO]);
  const { page, ask, accept } = await open(drawer.client);
  track(page);
  await ask();
  // Tab 1's accept commits, and its answer is lost.
  drawer.loseNext();
  await accept();
  await page.click('[data-assistant="new"]');
  await ask();
  await accept();
  await page.click('[data-chat]');
  await accept();
  // Tab 1's click again replays op-1 with its own body; tab 2's never carried it.
  expect(drawer.ids).toStrictEqual(['op-1', 'op-2', 'op-1']);
  expect(page.find('[data-plan="approved"]')).not.toBeNull();
});

it('AW04FIX4-F2 a kept accept stays with its session: another grant key on the same version mints its own id', async () => {
  const drawer = registerClient([TAB_ONE, TAB_ONE]);
  const ada = await open(drawer.client, 'grant-ada');
  await ada.ask();
  drawer.loseNext();
  await ada.accept();
  await ada.page.unmount();
  const bea = await open(drawer.client, 'grant-bea');
  track(bea.page);
  await bea.ask();
  await bea.accept();
  expect(drawer.minted()).toBe(2);
  expect(drawer.ids).toStrictEqual(['op-1', 'op-2']);
});

it('AW04FIX4-F1b an accept refused OPERATION_ID_REUSED drops that id: the click again mints a new one and lands', async () => {
  const drawer = registerClient([TAB_ONE], ['op-1']);
  // Its own session, so no id an earlier test kept is in play.
  const { page, ask, accept } = await open(drawer.client, 'grant-cal');
  track(page);
  await ask();
  await accept();
  expect(page.find('[data-plan="refusal"]')?.textContent).toContain('OPERATION_ID_REUSED');
  await accept();
  expect(drawer.ids).toStrictEqual(['op-1', 'op-2']);
  expect(page.find('[data-plan="approved"]')).not.toBeNull();
});
