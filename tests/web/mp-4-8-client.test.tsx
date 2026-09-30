// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's Client field and "Duplicate without contents" form on the dock
// task panel (CS-4.12, DP-19). While the task is empty the Client select
// sends `task.set_party` at the revision read; once it has content the select
// is locked in the same look, with the ticket's line and the action. The form
// carries the shell (the title and the subtasks' names), marks each carried
// field, and sends through the injected sender; the server's carried-text
// warning is drawn on each field it names, and the create waits for the
// person's confirmation. The client list, the content answer and
// `task.duplicate` are not on this base: they come through the panel's seams,
// and made-up ones carry the one Mock label. The server side (the lock, the
// refusals, the audit, the crossings) is S0-5's and `task.duplicate`'s suites.

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
  TaskClientFacts,
} from '../../apps/web/src/screens/task/client-seam.ts';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const A = { id: 'c-a', name: 'Acme Physio' };
const B = { id: 'c-b', name: 'Birch Dental' };
const LINE =
  'This task has content, so its client is locked. Duplicate it without contents to start one for another client.';

const facts = (over: Partial<TaskClientFacts> = {}): ClientFactsSource => ({
  provenance: 'real',
  useFacts: (_task, grantKey) => ({
    state: {
      outcome: 'ready',
      value: { choices: [A, B], current: null, hasContent: false, ...over },
      refusal: null,
      because: null,
      grantKey,
    },
    reload: () => {
      /* unread */
    },
  }),
});

const LOCKED = facts({ current: A.id, hasContent: true });

const refusal = (code: string, names: readonly string[], fixes: readonly string[]) => {
  const answer: unknown = { refused: true, code, names, fixes };
  return answer as WireRefusal;
};

const landed = (key: string): CallResult<CommandOutcome> => ({
  ok: true,
  value: { recordId: 't-new', revision: 1, detail: { taskId: 't-new', key } },
});

/** A sender answering in turn, recording every request. */
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

/** The panel on a task with content, its form opened. */
const opened = async (duplicate: DuplicateSource, onDuplicated?: (key: string) => void) => {
  const view = await panel(serving(SHELL).client, {
    client: {
      clientFacts: LOCKED,
      duplicate,
      ...(onDuplicated === undefined ? {} : { onDuplicated }),
    },
  });
  await view.click('[data-panel-field="duplicate"]');
  return view;
};

const warnings = (view: Awaited<ReturnType<typeof panel>>) =>
  view
    .all('[data-carried-warning]')
    .map((one) => one.closest<HTMLElement>('[data-carried]')?.dataset['carried']);

describe('MP-4-8 client select changes an empty task’s client', () => {
  it('offers the real clients and sends task.set_party at the read revision', async () => {
    const { client, sent } = serving();
    let changed = 0;
    const view = await panel(client, {
      changed: () => (changed += 1),
      client: { clientFacts: facts() },
    });
    const select = view.find('#panel-field-client') as HTMLSelectElement | null;
    expect([...(select?.options ?? [])].map((option) => option.text)).toStrictEqual([
      'No client',
      'Acme Physio',
      'Birch Dental',
    ]);
    expect(select?.disabled).toBe(false);
    await view.choose('#panel-field-client', B.id);
    await tick();
    expect(sent.map((one) => [one.to, one.body])).toStrictEqual([
      [
        '/task/set_party',
        {
          recordId: TASK_ID,
          fields: { client: B.id },
          expectedRevision: 4,
          operationId: sent[0]?.body['operationId'],
        },
      ],
    ]);
    expect(changed).toBe(1);
    expect(view.text()).not.toContain(LINE);
    await view.unmount();
  });
});

describe('MP-4-8 locked client offers Duplicate without contents', () => {
  it('draws the client locked with the ticket’s line and the action, and sends nothing', async () => {
    const { client, sent } = serving();
    const view = await panel(client, { client: { clientFacts: LOCKED } });
    const select = view.find('#panel-field-client') as HTMLSelectElement | null;
    expect(select?.disabled).toBe(true);
    expect(select?.value).toBe(A.id);
    expect(view.text()).toContain(LINE);
    expect(view.find('[data-panel-field="duplicate"]')?.textContent).toBe(
      'Duplicate without contents',
    );
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });
});

describe('MP-4-8 duplicate form marks carried text', () => {
  it('prefills the shell from the old task and marks each carried field', async () => {
    const view = await opened(sender().source);
    expect((view.find('#duplicate-title') as HTMLInputElement | null)?.value).toBe(SHELL.title);
    expect(
      view.all('[id^="duplicate-step-"]').map((one) => (one as HTMLInputElement).value),
    ).toStrictEqual(['Pull the spend report', 'Email Acme Physio the summary']);
    expect(
      view.all('[data-carried]').map((one) => (one as HTMLElement).dataset['carried']),
    ).toStrictEqual(['title', 'stepNames.0', 'stepNames.1']);
    expect(view.all('[data-carried] .field__hint').map((one) => one.textContent)).toStrictEqual([
      'Carried from the old task',
      'Carried from the old task',
      'Carried from the old task',
    ]);
    const choices = view.find('#duplicate-client') as HTMLSelectElement | null;
    expect([...(choices?.options ?? [])].map((option) => option.value)).toStrictEqual(['', B.id]);
    await view.unmount();
  });

  it('sends the chosen client and the shell as edited, unconfirmed', async () => {
    const { source, sent } = sender(landed('BIRCH-1'));
    const view = await opened(source);
    await view.type('#duplicate-title', 'Budget pacing fix');
    await view.choose('#duplicate-client', B.id);
    await view.click('[data-duplicate="create"]');
    await tick();
    expect(sent).toStrictEqual([
      {
        recordId: TASK_ID,
        client: B.id,
        title: 'Budget pacing fix',
        stepNames: ['Pull the spend report', 'Email Acme Physio the summary'],
        confirmCarried: false,
      },
    ]);
    await view.unmount();
  });
});

describe('MP-4-8 carried text warns on the old client’s name (form)', () => {
  const warned = refusal(
    'CARRIED_TEXT_NAMES_CLIENT',
    ['title', 'stepNames.1'],
    ['Carried text names the old task’s client.'],
  );

  it('warns on each named field, waits for the confirmation, then resends confirmed', async () => {
    const { source, sent } = sender(warned, landed('BIRCH-1'));
    const view = await opened(source);
    await view.choose('#duplicate-client', B.id);
    await view.click('[data-duplicate="create"]');
    await tick();
    expect(warnings(view)).toStrictEqual(['title', 'stepNames.1']);
    const create = view.find('[data-duplicate="create"]') as HTMLButtonElement | null;
    expect(create?.disabled).toBe(true);
    await view.click('#duplicate-confirm');
    expect(create?.disabled).toBe(false);
    await view.click('[data-duplicate="create"]');
    await tick();
    expect(sent.map((one) => one.confirmCarried)).toStrictEqual([false, true]);
    await view.unmount();
  });

  it('once the person edits the name out of both fields, no warning shows', async () => {
    const { source } = sender(warned);
    const view = await opened(source);
    await view.choose('#duplicate-client', B.id);
    await view.click('[data-duplicate="create"]');
    await tick();
    expect(warnings(view)).toHaveLength(2);
    await view.type('#duplicate-title', 'Budget pacing fix');
    await view.type('#duplicate-step-1', 'Email the client the summary');
    expect(warnings(view)).toStrictEqual([]);
    expect(view.find('#duplicate-confirm')).toBeNull();
    expect((view.find('[data-duplicate="create"]') as HTMLButtonElement | null)?.disabled).toBe(
      false,
    );
    await view.unmount();
  });
});

describe('MP-4-8 duplicate refusal quoted in the server’s words', () => {
  it('any other refusal is quoted and nothing opens', async () => {
    const { source } = sender(
      refusal('SCOPE_NOT_GRANTED', ['task:write'], ['Ask an administrator for task write.']),
    );
    const opens: string[] = [];
    const view = await opened(source, (key) => opens.push(key));
    await view.choose('#duplicate-client', B.id);
    await view.click('[data-duplicate="create"]');
    await tick();
    expect(view.find('[data-duplicate-form] [role="alert"]')?.textContent).toBe(
      'SCOPE_NOT_GRANTED (task:write). Ask an administrator for task write.',
    );
    expect(warnings(view)).toStrictEqual([]);
    expect(opens).toStrictEqual([]);
    await view.unmount();
  });
});

describe('MP-4-8 duplicate opens the new task', () => {
  it('a landed duplicate hands the new task’s key to the host', async () => {
    const opens: string[] = [];
    const view = await opened(sender(landed('BIRCH-7')).source, (key) => opens.push(key));
    await view.choose('#duplicate-client', B.id);
    await view.click('[data-duplicate="create"]');
    await tick();
    expect(opens).toStrictEqual(['BIRCH-7']);
    await view.unmount();
  });
});

describe('MP-4-8 client field marks made-up data mock', () => {
  it('the made-up client list and duplicate carry the one Mock label', async () => {
    const view = await panel(serving(SHELL).client);
    expect(view.find('[data-panel-field="client"] .mocktag')?.textContent).toBe('Mock');
    await view.click('[data-panel-field="duplicate"]');
    expect(view.find('[data-duplicate-form] .mocktag')?.textContent).toBe('Mock');
    await view.unmount();
  });

  it('real sources carry no Mock label', async () => {
    const view = await opened(sender().source);
    expect(view.find('[data-panel-field="client"]')).not.toBeNull();
    expect(view.find('[data-duplicate-form]')).not.toBeNull();
    expect(view.all('.mocktag')).toStrictEqual([]);
    await view.unmount();
  });
});
