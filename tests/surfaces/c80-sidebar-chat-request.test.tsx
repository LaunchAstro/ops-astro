// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// C80, the owner check's first step: a person asks in the sidebar chat for a
// one-word change on a page of the site, and the chat draws the request as a
// card (page, word, replacement, the line before and after, the approval
// state). The operations client is a recorder standing in for the network
// only; `live_correction.request` itself is proven on the real routes in
// `tests/site/c80-*.test.ts`. Where the site's read is not joined, the drawer
// answers from a made-up desk, and everything it draws carries the mock label.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import {
  readCorrectionAsk,
  type CorrectionAsk,
  type CorrectionDesk,
  type CorrectionTarget,
} from '../../apps/web/src/assistant/correction.ts';
import { liveDesk } from '../../apps/web/src/assistant/correction-desks.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { AssistantCorrection } from '../../packages/ui/src/index.ts';
import { mount, settle } from './mount.tsx';
import { chat, drawer, press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const PARTY = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const CORRECTION = '44444444-4444-4444-8444-444444444444';
const VERSION = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const ASKED = 'Change alongside to beside on the About page';
const LINE = 'We work alongside the teams who run your website.';

interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

type Grant = { readonly collection: string; readonly action: string };

const RUN_WRITE: Grant = { collection: 'run', action: 'write' };

const refusal = (code: string, fix: string) => ({
  ok: false,
  refused: true,
  code,
  names: [],
  fixes: [fix],
});

/** The API as far as the drawer reaches it: the grant read and the commands it sends. */
function server(options: { grants: readonly Grant[]; refuse?: string }): {
  readonly client: OperationsClient;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const client = {
    read: async (name: string, body: Readonly<Record<string, unknown>>) => {
      await Promise.resolve();
      sent.push({ name, body });
      if (options.grants.length === 0) return refusal('SCOPE_NOT_GRANTED', 'Ask for a grant.');
      return {
        ok: true,
        value: { ok: true, personId: PARTY, businessKey: 'alpha', grants: options.grants },
      };
    },
    mutate: async (name: string, body: Readonly<Record<string, unknown>>) => {
      await Promise.resolve();
      sent.push({ name, body });
      if (name !== 'live_correction.request') {
        return {
          ok: true,
          value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION } },
        };
      }
      if (options.refuse !== undefined) return refusal('SCOPE_NOT_GRANTED', options.refuse);
      return {
        ok: true,
        value: {
          recordId: CORRECTION,
          revision: 1,
          detail: {
            correctionId: CORRECTION,
            versionId: VERSION,
            versionDigest: 'sha256:aa',
            state: 'requested',
          },
        },
      };
    },
  } as unknown as OperationsClient;
  return { client, sent };
}

/** Where the word sits on the site: the read the drawer does not reach yet, stood in here. */
const located = (wanted: CorrectionAsk): Promise<CorrectionTarget | null> =>
  Promise.resolve(
    wanted.page === 'About'
      ? {
          partyId: PARTY,
          taskId: TASK,
          path: 'src/pages/about.astro',
          pageUrl: 'https://agencyastro.com/about',
          baseRevision: 'abc123',
          before: LINE,
        }
      : null,
  );

async function view(options: { grants: readonly Grant[]; refuse?: string; live: boolean }) {
  const { client, sent } = server(options);
  const desk: CorrectionDesk | undefined = options.live ? liveDesk(client, located) : undefined;
  const page = track(
    await mount(
      <AssistantView
        client={client}
        route="agency:settings"
        here="/settings"
        entry={null}
        onClose={() => {}}
        {...(desk === undefined ? {} : { corrections: desk })}
      />,
    ),
  );
  return { page, sent };
}

async function ask(page: Awaited<ReturnType<typeof view>>['page'], text: string): Promise<void> {
  await page.type('[data-assistant="input"]', text);
  await press(page, '[data-assistant="input"]', 'Enter');
  for (let turn = 0; turn < 4; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- one flush per awaited step of the ask
    await settle();
  }
}

const field = (page: { find: (s: string) => Element | null }, name: string): string =>
  page.find(`[data-correction-field="${name}"]`)?.textContent ?? '';

describe('C80 sidebar chat request', () => {
  it('the card shows the page, the word, its replacement and the line before and after', async () => {
    const { page, sent } = await view({ grants: [RUN_WRITE], live: true });
    await ask(page, ASKED);
    expect(sent.find((each) => each.name === 'live_correction.request')?.body).toStrictEqual({
      partyId: PARTY,
      taskId: TASK,
      path: 'src/pages/about.astro',
      word: 'alongside',
      replacement: 'beside',
      pageUrl: 'https://agencyastro.com/about',
      baseRevision: 'abc123',
      before: LINE,
      after: 'We work beside the teams who run your website.',
    });
    expect(field(page, 'page')).toBe('About');
    expect(field(page, 'word')).toBe('alongside');
    expect(field(page, 'replacement')).toBe('beside');
    expect(field(page, 'before')).toBe(`Before${LINE}`);
    expect(field(page, 'after')).toBe('AfterWe work beside the teams who run your website.');
    expect(page.find('[data-correction]')?.getAttribute('data-correction')).toBe('waiting');
    expect(page.find('[data-correction]')?.textContent).toContain(
      'Waiting for the configured approver',
    );
  });
});

describe('C80 sidebar chat request', () => {
  it('the approval state reads waiting, approved or refused in words', async () => {
    const correction = (state: AssistantCorrection['state']): AssistantCorrection => ({
      page: 'About',
      word: 'alongside',
      replacement: 'beside',
      before: LINE,
      after: 'We work beside the teams who run your website.',
      state,
      approver: null,
      checkable: false,
    });
    const states = ['waiting', 'approved', 'refused'] as const;
    const page = await drawer({
      chats: [
        chat('1', {
          messages: states.map((state) => ({
            id: state,
            role: 'ai',
            body: 'Asked.',
            cites: [],
            correction: correction(state),
          })),
        }),
      ],
    });
    expect(
      page.all('[data-correction]').map((card) => card.getAttribute('data-correction')),
    ).toStrictEqual([...states]);
    expect(page.all('[data-correction-state]').map((mark) => mark.textContent)).toStrictEqual([
      'Waiting for the configured approver',
      'Approved by the configured approver',
      'Refused by the configured approver',
    ]);
  });
});

describe('C80 sidebar chat request', () => {
  it('a made-up answer carries the mock label and a real one does not', async () => {
    const made = await view({ grants: [RUN_WRITE], live: false });
    await ask(made.page, ASKED);
    const card = made.page.find('[data-correction]');
    expect(card).not.toBeNull();
    expect(card?.closest('.is-mock')?.querySelector('.mocktag')?.textContent).toBe('Mock');
    expect(made.sent.map((each) => each.name)).toStrictEqual(['session.capabilities']);

    const real = await view({ grants: [RUN_WRITE], live: true });
    await ask(real.page, ASKED);
    expect(real.page.find('[data-correction]')).not.toBeNull();
    expect(real.page.all('.mocktag')).toHaveLength(0);
    expect(real.page.all('.is-mock')).toHaveLength(0);
  });

  it('the made-up approver decision is read again and stays marked', async () => {
    const { page } = await view({ grants: [RUN_WRITE], live: false });
    await ask(page, ASKED);
    await page.click('[data-correction-check] button');
    await settle();
    expect(page.find('[data-correction]')?.getAttribute('data-correction')).toBe('approved');
    expect(page.find('[data-correction]')?.closest('.is-mock')).not.toBeNull();
  });
});

describe('C80 sidebar chat request', () => {
  it('a person without run:write sees no card and nothing is requested', async () => {
    for (const live of [true, false]) {
      // eslint-disable-next-line no-await-in-loop -- one drawer per desk, in turn
      const { page, sent } = await view({ grants: [{ collection: 'task', action: 'read' }], live });
      // eslint-disable-next-line no-await-in-loop -- as above
      await ask(page, ASKED);
      expect(page.find('[data-correction]')).toBeNull();
      expect(sent.map((each) => each.name)).toStrictEqual(['session.capabilities']);
      expect(page.find('[data-message-role="failed"]')?.textContent).toContain('run:write');
    }
  });

  it('a request the server refuses for want of the grant draws no card', async () => {
    const { page } = await view({ grants: [RUN_WRITE], refuse: 'Ask an owner.', live: true });
    await ask(page, ASKED);
    expect(page.find('[data-correction]')).toBeNull();
    expect(page.find('[data-message-role="failed"]')?.textContent).toContain('Ask an owner.');
  });

  it('only a one-word change on a named page reads as a request; a question is still asked', async () => {
    expect(readCorrectionAsk(ASKED)).toStrictEqual({
      page: 'About',
      word: 'alongside',
      replacement: 'beside',
    });
    expect(readCorrectionAsk('Replace “alongside” with “beside” on the about page.')).toStrictEqual(
      { page: 'About', word: 'alongside', replacement: 'beside' },
    );
    expect(readCorrectionAsk('Change our team to the team on the About page')).toBeNull();
    expect(readCorrectionAsk('What does this setting do?')).toBeNull();
    const { page, sent } = await view({ grants: [RUN_WRITE], live: true });
    await ask(page, 'What does this setting do?');
    expect(sent.map((each) => each.name)).toStrictEqual(['conversation.start']);
  });
});
