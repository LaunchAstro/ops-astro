// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 CS-7.33 and AW-04, a reopened tab folded into its own original tab
// when that tab's start lands late: a question still out there keeps the tab
// answering, an accept still out there settles the card it moved, and a plan
// version offered there stays the current one over the start's older version.

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the drawer's own tests do */

import { afterEach, describe, expect, it } from 'vitest';
import type { PlanOffer } from '../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { settle, type Mounted } from './mount.tsx';
import { press, unmountAll } from './mp-7-11-drawer-fixtures.tsx';
import {
  bodies,
  drawerFor,
  message,
  serving,
  tabTitles,
  MADE,
  type Stored,
} from './drawer-history-support.tsx';

afterEach(unmountAll);

const TASK = '55555555-5555-4555-8555-555555555555';

/** Plan version `version` of one task's one proposal, as a planning reply offers it. */
const offer = (version: number): PlanOffer => ({
  gateId: `66666666-6666-4666-8666-66666666666${String(version)}`,
  versionId: `77777777-7777-4777-8777-77777777777${String(version)}`,
  version,
  task: { id: TASK, key: 'T-12', title: 'Brief for the spring range' },
  text: `Draft the brief, version ${String(version)}. Ceiling: $10.00.`,
  steps: [{ key: 'draft', title: 'Draft the brief', after: [] }],
  ceilingMinor: 1000,
  currency: 'AUD',
  planningSpendMinor: 12,
  entryPath: 'agents/brief.md',
  paths: [],
});

type Reply = Readonly<Record<string, unknown>>;

const plain = (body: string): Reply => ({ answered: true, body });
const planned = (version: number): Reply => ({
  answered: true,
  messageId: `m-${String(version)}`,
  body: 'Here is the plan.',
  plan: offer(version),
});

const answer = (revision: number, reply: Reply) => ({
  ok: true,
  value: { recordId: MADE, revision, detail: { conversationId: MADE }, reply },
});

/** An answer held until its `release` is called. */
function held<T>(value: T) {
  let release: (() => void) | undefined;
  const sent = new Promise<T>((resolve) => {
    release = () => {
      resolve(value);
    };
  });
  return { sent, release: () => release?.() };
}

const firstAsked = (): Stored => ({
  [MADE]: { title: 'Chat 1', messages: [message('m1', 'person', 'First question?')] },
});

async function ask(page: Mounted, text: string): Promise<void> {
  await page.type('[data-assistant="input"]', text);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

/** Asks the first question, reopens its conversation from the history, and asks `then` there. */
async function askedInTwin(client: OperationsClient, then: string): Promise<Mounted> {
  const page = await drawerFor(client);
  await ask(page, 'First question?');
  await page.click('[data-assistant="history"]');
  await settle();
  await page.click(`[data-past="${MADE}"]`);
  await settle();
  await ask(page, then);
  return page;
}

async function landed(): Promise<void> {
  await settle();
  await settle();
}

// eslint-disable-next-line max-lines-per-function -- one drawer, each fold race named
describe('MP-7-11 a reopened tab folded in when its own tab’s start lands late', () => {
  it('CS-7.33 the tab stays answering while the question asked in the reopened tab is still out', async () => {
    const start = held(answer(1, plain('First answer.')));
    const second = held(answer(2, plain('Second answer.')));
    const { client } = serving(firstAsked(), ({ name }) =>
      name === 'conversation.start'
        ? start.sent
        : name === 'conversation.message'
          ? second.sent
          : Promise.resolve({ unavailable: true, because: 'n/a' }),
    );
    const page = await askedInTwin(client, 'Second question?');
    start.release();
    await landed();
    expect(tabTitles(page)).toHaveLength(1);
    expect(page.find('[data-assistant="answering"]')).not.toBeNull();
    second.release();
    await landed();
    expect(page.find('[data-assistant="answering"]')).toBeNull();
    expect(bodies(page)).toStrictEqual([
      'user: First question?',
      'ai: First answer.',
      'user: Second question?',
      'ai: Second answer.',
    ]);
  });

  it('AW-04 an accept still out when the reopened tab folds in settles the card it moved', async () => {
    const start = held(answer(1, plain('First answer.')));
    const accepted = held({
      ok: true,
      value: { recordId: '', revision: 0, detail: { runId: 'r' } },
    });
    const base = serving(firstAsked(), ({ name }) =>
      name === 'conversation.start'
        ? start.sent
        : name === 'conversation.message'
          ? Promise.resolve(answer(2, planned(1)))
          : name === 'task.accept_plan'
            ? accepted.sent
            : Promise.resolve({ unavailable: true, because: 'n/a' }),
    );
    const client = { ...base.client, newOperationId: () => 'op-fold' } as OperationsClient;
    const page = await askedInTwin(client, 'Plan the brief');
    await page.click('[data-plan="accept"]');
    await settle();
    expect(page.find('[data-plan="accept"]')?.hasAttribute('disabled')).toBe(true);
    start.release();
    await landed();
    expect(tabTitles(page)).toHaveLength(1);
    accepted.release();
    await landed();
    const approved = page.find('[data-plan="approved"]');
    expect(approved?.textContent).toContain('Exact words kept');
    expect(approved?.textContent).toContain('Run started');
    expect(page.find('[data-plan="accept"]')).toBeNull();
  });

  it('AW-04 the start’s older plan version never replaces the newer one offered in the reopened tab', async () => {
    const start = held(answer(1, planned(1)));
    const { client } = serving(firstAsked(), ({ name }) =>
      name === 'conversation.start'
        ? start.sent
        : name === 'conversation.message'
          ? Promise.resolve(answer(2, planned(2)))
          : Promise.resolve({ unavailable: true, because: 'n/a' }),
    );
    const page = await askedInTwin(client, 'Revise the plan');
    expect(page.all('[data-plan="accept"]')).toHaveLength(1);
    start.release();
    await landed();
    expect(tabTitles(page)).toHaveLength(1);
    const accepts = page.all('[data-plan="accept"]');
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.closest('[data-plan="card"]')?.getAttribute('data-version')).toBe('2');
    expect(page.find('[data-plan="stale"]')?.textContent).toContain('Replaced by Version 2');
  });
});
