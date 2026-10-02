// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2D-1 red proof (REVIEW-BATCH #315, batch 2d). DuplicateForm's
// `edit()` clears only the edited field's warning and never resets
// `confirmed`, and `create()` sends `confirmCarried: warned.size > 0 &&
// confirmed`. So one confirmation, given for the carried text the server
// warned on, still rides along after the person types new text into a warned
// field while another field stays warned; the server then skips the
// client-name check for every field, including the new text it never saw.
// Passes once an edit to a warned field resets the confirmation (Create
// disabled until confirmed again, or the next send carries
// `confirmCarried: false`).

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

const sender = (...answers: CallResult<CommandOutcome>[]) => {
  const sent: DuplicateRequest[] = [];
  const source: DuplicateSource = {
    provenance: 'real',
    send: (request) => {
      sent.push(request);
      return Promise.resolve(answers.shift() ?? landed('NEVER'));
    },
  };
  return { source, sent };
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

describe('REVIEW-2D-1 duplicate confirmation does not survive later edits', () => {
  it('REVIEW-2D-1: one client-name confirm covers later edits; editing a warned field after confirming must not resend confirmCarried true', async () => {
    const { source, sent } = sender(warned, landed('BIRCH-1'));
    const view = await panel(serving(SHELL).client, {
      client: { clientFacts: LOCKED, duplicate: source },
    });
    await view.click('[data-panel-field="duplicate"]');
    await view.choose('#duplicate-client', B.id);
    await view.click('[data-duplicate="create"]');
    await tick();
    expect(sent.map((one) => one.confirmCarried)).toStrictEqual([false]);
    await view.click('#duplicate-confirm');
    // New text the server never checked, still naming the old client.
    await view.type('#duplicate-title', 'Acme Physio pacing fix, round two');
    const create = view.find('[data-duplicate="create"]') as HTMLButtonElement | null;
    if (create !== null && !create.disabled) {
      await view.click('[data-duplicate="create"]');
      await tick();
    }
    expect(
      sent.at(-1)?.confirmCarried,
      'the confirm given before the title edit was sent as confirmCarried: true for the new, unchecked title',
    ).toBe(false);
    await view.unmount();
  });
});
