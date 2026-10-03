// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// AW-04's plan card on the approval path: everything the one click binds (the
// words, each step and what it waits on, the files, the ceiling) the card drew,
// and the figures agree with the words; an accept whose answer lands after a newer version
// arrived still says what the server did; and an accept whose outcome is
// unknown is retried under its own operation id, so the register can replay it,
// even after a newer version made its card stale.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import type { PlanOffer } from '../../packages/core-wire/src/index.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '44444444-4444-4444-8444-444444444444';

const offer = (version: number): PlanOffer => ({
  gateId: '66666666-6666-4666-8666-666666666666',
  versionId: `77777777-7777-4777-8777-77777777777${String(version)}`,
  version,
  task: { id: '55555555-5555-4555-8555-555555555555', key: 'T-12', title: 'Spring brief' },
  text: 'Draft the brief, then check it. Ceiling: $10.00. Launch happens later, on the task.',
  steps: [
    { key: 'draft', title: 'Draft the brief', after: [] },
    { key: 'check', title: 'Check it', after: ['draft'] },
  ],
  ceilingMinor: 1000,
  currency: 'AUD',
  planningSpendMinor: 12,
  entryPath: 'agents/brief.md',
  paths: ['agents/notes.md', 'agents/style.md'],
});

const planned = (version: number) => ({
  answered: true,
  messageId: `m-${String(version)}`,
  body: 'Here is the plan.',
  plan: offer(version),
});

const APPROVED = { ok: true, value: { recordId: '', revision: 0, detail: { runId: 'run-1' } } };
// An accept whose answer has not come yet, and one whose answer the network dropped.
const unanswered = (_value: unknown): void => {};
const lostAnswer = (): Promise<unknown> =>
  Promise.resolve({ unavailable: true, because: 'The network dropped the answer.' });

interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly options: { readonly operationId?: string } | undefined;
}

/** Replies answer conversation writes in turn; accepts answer from `accepts` in turn. */
function drawerWith(replies: readonly unknown[], accepts: (() => Promise<unknown>)[]) {
  const sent: Sent[] = [];
  const queue = [...replies];
  let minted = 0;
  const client = {
    newOperationId: () => {
      minted += 1;
      return `op-${String(minted)}`;
    },
    // The allowance line's read (AW-04 on main), not asked here.
    read: () => Promise.resolve({ unavailable: true, because: 'not asked here' }),
    mutate: (
      name: string,
      body: Readonly<Record<string, unknown>>,
      options?: { readonly operationId?: string },
    ) => {
      sent.push({ name, body, options });
      if (name === 'task.accept_plan') return accepts.shift()?.() ?? Promise.resolve(APPROVED);
      const reply = queue.shift();
      return Promise.resolve({
        ok: true,
        value: {
          recordId: '',
          revision: 0,
          detail: { conversationId: CONVERSATION },
          ...(reply === undefined ? {} : { reply }),
        },
      });
    },
  } as unknown as OperationsClient;
  return { client, sent };
}

async function open(client: OperationsClient) {
  const page = track(
    await mount(
      <AssistantView
        client={client}
        route="agency:projects-board"
        here="/projects"
        entry={null}
        onClose={() => {}}
      />,
    ),
  );
  const ask = async (text: string): Promise<void> => {
    await page.type('[data-assistant="input"]', text);
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
  };
  return { page, ask };
}

describe('AW-04 plan card accept', () => {
  it('AW-04 plan card binds what it shows: every bound field the accept sends is drawn on the card', async () => {
    const { client, sent } = drawerWith([planned(1)], []);
    const { page, ask } = await open(client);
    await ask('Write the spring brief');
    await page.click('[data-plan="accept"]');
    await settle();
    const body = sent.find((each) => each.name === 'task.accept_plan')?.body ?? {};
    const card = page.find('[data-plan="card"]');
    // "Exact words kept" claims the person approved these words; they must have been on screen.
    expect(body['planText']).toBe(offer(1).text);
    expect(card?.textContent).toContain(body['planText']);
    const steps = (body['plan'] as { steps: PlanOffer['steps'] }).steps;
    const drawn = page.all('[data-plan="steps"] li').map((each) => each.textContent);
    const titleOf = (key: string) => steps.find((each) => each.key === key)?.title;
    expect(drawn).toStrictEqual(
      steps.map((step) =>
        step.after.length === 0
          ? step.title
          : `${step.title} after: ${step.after.map(titleOf).join(', ')}`,
      ),
    );
    expect(page.find('[data-plan="entry"]')?.textContent).toContain(body['entryPath']);
    for (const path of body['paths'] as string[]) {
      expect(page.find('[data-plan="paths"]')?.textContent).toContain(path);
    }
    // The ceiling the click names is the one the card drew, and the words name it too.
    expect(body['ceilingMinor']).toBe(offer(1).ceilingMinor);
    expect(body['currency']).toBe(offer(1).currency);
    expect(page.find('[data-plan="cost"]')?.textContent).toContain('AUD 10.00');
    expect(offer(1).text).toContain('$10.00');
  });

  it('AW-04 accept answered after a newer version arrived: a committed accept still shows the approved card, never "accept the newer card"', async () => {
    let answer: (value: unknown) => void = unanswered;
    const inFlight = (): Promise<unknown> =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const { client } = drawerWith([planned(1), planned(2)], [inFlight]);
    const { page, ask } = await open(client);
    await ask('Write the spring brief');
    await page.click('[data-plan="accept"]');
    // While the click is in flight, the next planning reply lands with version 2.
    await ask('Make the check shorter');
    answer(APPROVED);
    await settle();
    const first = page
      .all('[data-plan="card"]')
      .find((each) => each.getAttribute('data-version') === '1');
    // The server kept version 1's words and started its run.
    expect(first?.querySelector('[data-plan="approved"]')).not.toBeNull();
    expect(first?.querySelector('[data-plan="stale"]')).toBeNull();
  });

  it('AW-04 accept with an unknown outcome: the click again reuses the operation id, so a committed accept replays', async () => {
    const { client, sent } = drawerWith([planned(1)], [lostAnswer]);
    const { page, ask } = await open(client);
    await ask('Write the spring brief');
    await page.click('[data-plan="accept"]');
    await settle();
    await page.click('[data-plan="accept"]');
    await settle();
    const accepts = sent.filter((each) => each.name === 'task.accept_plan');
    expect(accepts).toHaveLength(2);
    expect(accepts[0]?.options?.operationId).toBeDefined();
    expect(accepts[1]?.options?.operationId).toBe(accepts[0]?.options?.operationId);
  });

  it('SL12-24-F5 accept with a lost answer, then a newer version: the stale card keeps its replay, and a committed replay approves it', async () => {
    const { client, sent } = drawerWith([planned(1), planned(2)], [lostAnswer]);
    const { page, ask } = await open(client);
    await ask('Write the spring brief');
    await page.click('[data-plan="accept"]');
    await settle();
    // Version 1's run may have started; version 2 lands before anyone knows.
    await ask('Make the check shorter');
    const first = () =>
      page.all('[data-plan="card"]').find((each) => each.getAttribute('data-version') === '1');
    expect(first()?.querySelector('[data-plan="unknown"]')?.textContent).toContain('Version 2');
    await page.click('[data-version="1"] [data-plan="accept"]');
    await settle();
    const accepts = sent.filter((each) => each.name === 'task.accept_plan');
    expect(accepts).toHaveLength(2);
    expect(accepts[1]?.options?.operationId).toBe(accepts[0]?.options?.operationId);
    // The replay found the accept committed: version 1 is the approved card.
    expect(first()?.querySelector('[data-plan="approved"]')).not.toBeNull();
    expect(first()?.querySelector('[data-plan="unknown"]')).toBeNull();
  });
});
