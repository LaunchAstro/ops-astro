// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// AW-04's drawer legs: the plan as a card in the chat, the one click that
// accepts it, the approved card that says the exact words were kept, and a
// planning reply that drops composing no plan version. The operations client
// is a recorder standing in for the network only: each reply the drawer reads
// is the next one in the test's list, and each test reads what a press sent.
// The accept itself (`task.accept_plan`) is proven on the real command in
// tests/runtime/aw-04-accept-command.test.ts and its neighbours.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import type { PlanOffer } from '../../packages/core-wire/src/index.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';

/** A plan version as a planning reply offers it. */
const offer = (version: number): PlanOffer => ({
  gateId: '66666666-6666-4666-8666-666666666666',
  versionId: `77777777-7777-4777-8777-77777777777${String(version)}`,
  version,
  task: { id: TASK, key: 'T-12', title: 'Brief for the spring range' },
  text:
    'Draft the brief, then check it against the notes. Ceiling: $10.00. ' +
    'Launch happens later, on the task.',
  steps: [
    { key: 'draft', title: 'Draft the brief', after: [] },
    { key: 'check', title: 'Check it against the notes', after: ['draft'] },
  ],
  ceilingMinor: 1000,
  currency: 'AUD',
  planningSpendMinor: 12,
  entryPath: 'agents/brief.md',
  paths: ['agents/notes.md'],
});

const planned = (version: number) => ({
  answered: true,
  messageId: `m-${String(version)}`,
  body: 'Here is the plan.',
  plan: offer(version),
});

const DROPPED = {
  answered: false,
  code: 'PROVIDER_DROPPED',
  words: 'The planning reply dropped before it finished. Nothing was offered; ours.',
};

interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

type Answer = Readonly<Record<string, unknown>>;

/** Each conversation write answers the next reply; an accept answers `accept`. */
function recorder(replies: readonly Answer[], accept: Answer | null = null) {
  const sent: Sent[] = [];
  const queue = [...replies];
  const client = {
    newOperationId: () => 'op-1',
    // The allowance line's read (AW-04 on main), not asked here.
    read: () => Promise.resolve({ unavailable: true, because: 'not asked here' }),
    mutate: (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      if (name === 'task.accept_plan') {
        return Promise.resolve(
          accept ?? { ok: true, value: { recordId: '', revision: 0, detail: { runId: 'run-1' } } },
        );
      }
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

async function drawer(replies: readonly Answer[], accept: Answer | null = null) {
  const { client, sent } = recorder(replies, accept);
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
  return { page, sent, ask };
}

const texts = (page: { all: (s: string) => readonly Element[] }, selector: string) =>
  page.all(selector).map((each) => each.textContent);

// eslint-disable-next-line max-lines-per-function -- each drawer leg, in the ticket's order
describe('AW-04 drawer', () => {
  it('AW-04 plan card: a planning reply’s plan is drawn as a card in the chat, its steps, the rough cost, the planning spend and its version beside the one accept', async () => {
    const { page, ask } = await drawer([planned(1)]);
    await ask('Write the spring brief');
    expect(page.all('[data-plan="card"]')).toHaveLength(1);
    expect(texts(page, '[data-plan="step"]')).toStrictEqual([
      'Draft the brief',
      'Check it against the notes',
    ]);
    expect(page.find('[data-plan="cost"]')?.textContent).toContain('AUD 10.00');
    expect(page.find('[data-plan="spend"]')?.textContent).toContain('AUD 0.12');
    expect(page.find('[data-plan="version"]')?.textContent).toBe('Version 1');
    expect(page.all('[data-plan="accept"]')).toHaveLength(1);
    // Nothing is accepted by being shown.
    expect(page.find('[data-plan="approved"]')).toBeNull();
  });

  it('AW-04 one click accepts: the card sends task.accept_plan with the version on screen and the plan’s exact words, and the drawer shows the approved card: exact words kept, the task link and run started', async () => {
    const { page, sent, ask } = await drawer([planned(1)]);
    await ask('Write the spring brief');
    await page.click('[data-plan="accept"]');
    await settle();
    const accepts = sent.filter((each) => each.name === 'task.accept_plan');
    expect(accepts).toStrictEqual([
      {
        name: 'task.accept_plan',
        body: {
          gateId: offer(1).gateId,
          versionId: offer(1).versionId,
          note: 'Accepted in the drawer.',
          planText: offer(1).text,
          plan: { steps: offer(1).steps },
          entryPath: 'agents/brief.md',
          paths: ['agents/notes.md'],
          ceilingMinor: 1000,
          currency: 'AUD',
          conversationId: CONVERSATION,
        },
      },
    ]);
    const approved = page.find('[data-plan="approved"]');
    expect(approved?.textContent).toContain('Exact words kept');
    expect(approved?.textContent).toContain('Run started');
    expect(page.find('[data-plan="task"]')?.getAttribute('href')).toBe('/task/T-12');
    expect(page.find('[data-plan="accept"]')).toBeNull();
  });

  it('AW-04 a refused accept leaves the plan unapproved, quotes the server and offers the click again', async () => {
    const refusal = {
      ok: false,
      refused: true,
      code: 'VERSION_STALE',
      names: ['versionId'],
      fixes: ['A newer plan version replaced this one. Accept the version on screen.'],
    };
    const { page, ask } = await drawer([planned(1)], refusal);
    await ask('Write the spring brief');
    await page.click('[data-plan="accept"]');
    await settle();
    expect(page.find('[data-plan="approved"]')).toBeNull();
    expect(page.find('[data-plan="refusal"]')?.textContent).toContain('A newer plan version');
    expect(page.all('[data-plan="accept"]')).toHaveLength(1);
  });

  it('AW-04 composes no plan version: a planning reply that drops shows the drop and its fault and offers no plan; the resumed reply is a new version and the older card offers no accept', async () => {
    const { page, ask } = await drawer([DROPPED, planned(1), planned(2)]);
    await ask('Write the spring brief');
    expect(page.find('[data-message-role="failed"]')?.textContent).toContain('ours');
    expect(page.all('[data-plan="card"]')).toHaveLength(0);
    expect(page.all('[data-plan="accept"]')).toHaveLength(0);

    await ask('Try again');
    expect(texts(page, '[data-plan="version"]')).toStrictEqual(['Version 1']);

    await ask('Make the check shorter');
    expect(page.all('[data-plan="card"]')).toHaveLength(2);
    expect(page.all('[data-plan="accept"]')).toHaveLength(1);
    expect(page.find('[data-plan="stale"]')?.textContent).toContain('Version 2');
    expect(
      page
        .find('[data-plan="accept"]')
        ?.closest('[data-plan="card"]')
        ?.getAttribute('data-version'),
    ).toBe('2');
  });
});
