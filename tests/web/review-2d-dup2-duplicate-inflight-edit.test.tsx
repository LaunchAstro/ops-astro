// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-dup minor 3 red proof (PR #315, batch 2d, round 2). While a Create
// is in flight, DuplicateForm's carried inputs and client picker stay
// editable. The carried-text warning then settles against the shell that was
// sent, sets the confirm to asked, and the person's tick rides the next send
// as `confirmCarried: true` for text typed during the flight, which the
// server never checked. Passes once a warning that settles on a shell or
// client no longer on screen asks for no confirm, so the next send is
// unconfirmed and the server checks every field again.

import { afterEach, describe, expect, it } from 'vitest';
import type {
  CallResult,
  CommandOutcome,
  WireRefusal,
} from '../../apps/web/src/operations/client.ts';
import type {
  ClientFactsSource,
  DuplicateRequest,
  DuplicateSource,
} from '../../apps/web/src/screens/task/client-seam.ts';
import { tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const A = { id: 'c-a', name: 'Acme Physio' };
const B = { id: 'c-b', name: 'Birch Dental' };

const LOCKED: ClientFactsSource = {
  provenance: 'real',
  useFacts: (_task, grantKey) => ({
    state: {
      outcome: 'ready',
      value: { choices: [A, B], current: A.id, unseen: false, hasContent: true },
      refusal: null,
      because: null,
      grantKey,
    },
    reload: () => {
      /* unread */
    },
  }),
};

const refusal = (code: string, names: readonly string[], fixes: readonly string[]) => {
  const answer: unknown = { refused: true, code, names, fixes };
  return answer as WireRefusal;
};

const landed = (key: string): CallResult<CommandOutcome> => ({
  ok: true,
  value: { recordId: 't-new', revision: 1, detail: { taskId: 't-new', key } },
});

/** A sender whose first answer waits until the test settles it. */
const held = (...answers: CallResult<CommandOutcome>[]) => {
  const sent: DuplicateRequest[] = [];
  const waiting: ((answer: CallResult<CommandOutcome>) => void)[] = [];
  const source: DuplicateSource = {
    provenance: 'real',
    send: (request) => {
      sent.push(request);
      if (sent.length === 1)
        return new Promise((resolve) => {
          waiting.push(resolve);
        });
      return Promise.resolve(answers.shift() ?? landed('NEVER'));
    },
  };
  return {
    source,
    sent,
    settle: (answer: CallResult<CommandOutcome>) => waiting.shift()?.(answer),
  };
};

const step = (id: string, title: string) => ({
  id,
  key: `K-${id}`,
  title,
  state: null,
  done: false,
  archived: null,
  awaitingApproval: false,
  assignee: null,
  revision: 1,
});

const SHELL = {
  title: 'Acme Physio budget pacing fix',
  steps: [step('s1', 'Pull the spend report'), step('s2', 'Email Acme Physio the summary')],
};

const warned = refusal(
  'CARRIED_TEXT_NAMES_CLIENT',
  ['title', 'stepNames.1'],
  ['Carried text names the old task’s client.'],
);

describe('REVIEW-dup 3 a carried-text confirm covers only the shell the server warned on', () => {
  it('an edit while Create is in flight keeps the next send unconfirmed', async () => {
    const { source, sent, settle } = held(landed('BIRCH-1'));
    const view = await panel(serving(SHELL).client, {
      client: { clientFacts: LOCKED, duplicate: source },
    });
    await view.click('[data-panel-field="duplicate"]');
    await view.choose('#duplicate-client', B.id);
    await view.click('[data-duplicate="create"]');
    await tick();
    expect(sent.map((one) => one.confirmCarried)).toStrictEqual([false]);
    // New text, still naming the old client, typed while the send is pending.
    await view.type('#duplicate-step-1', 'Email Acme Physio the revised summary');
    settle(warned);
    await tick();
    if (view.find('#duplicate-confirm') !== null) await view.click('#duplicate-confirm');
    const create = view.find('[data-duplicate="create"]') as HTMLButtonElement | null;
    if (create !== null && !create.disabled) {
      await view.click('[data-duplicate="create"]');
      await tick();
    }
    expect(sent.at(-1)?.stepNames[1]).toBe('Email Acme Physio the revised summary');
    expect(
      sent.at(-1)?.confirmCarried,
      'a confirm asked on the sent shell was sent as confirmCarried: true for step text the server never checked',
    ).toBe(false);
    await view.unmount();
  });
});
