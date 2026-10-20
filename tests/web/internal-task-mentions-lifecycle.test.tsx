// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { settle } from '../surfaces/mount.tsx';
import {
  ADA,
  deferredResponse,
  Harness,
  PEOPLE,
  key,
  mentionAda,
  open,
  refusal,
  response,
  transport,
} from './internal-task-mentions-support.tsx';

it('an unknown mention post locks recipients and retries the exact payload after a reread', async () => {
  const server = transport();
  let calls = 0;
  server.answers.comment = () =>
    ++calls === 1
      ? Promise.reject(new Error('Answer lost'))
      : Promise.resolve(response({ recordId: 'task-one', revision: 9 }));
  const view = await open({ client: server.client });
  await mentionAda(view);
  await view.type('#comment-body', '@Ada Synthetic One note');
  await view.click('[data-comment="post"]');
  expect(view.text()).toContain('may already have been stored');
  expect(view.find('#comment-body')).toHaveProperty('disabled', true);
  expect(view.find('[data-internal-task-mentions] textarea')).toHaveProperty('disabled', true);
  await view.click('[role="tab"][id$="client"]');
  expect(view.find('[role="tab"][id$="internal"]')).toHaveProperty('ariaSelected', 'true');
  await view.type('#comment-body', 'Changed words');
  await view.render(<Harness client={server.client} revision={9} />);
  expect(view.find('#comment-body')).toHaveProperty('value', '@Ada Synthetic One note');
  server.answers.people = () => Promise.resolve(refusal('SCOPE_NOT_GRANTED'));
  await act(async () => {
    window.dispatchEvent(new Event('online'));
    await settle();
  });
  expect(view.find('[role=option]')).toBeNull();
  expect(view.find('#comment-body')).toHaveProperty('value', '@Ada Synthetic One note');
  expect(view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(view.find('[data-mention-clear]')).toHaveProperty('disabled', true);
  expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', false);
  await view.click('[data-comment="post"]');
  expect(server.posts()).toHaveLength(2);
  expect(server.posts()[1]?.body).toEqual(server.posts()[0]?.body);
  expect(server.posts()[1]?.body).toMatchObject({ mentions: [ADA], expectedRevision: 4 });
});

it('erasing the inline name removes the structured recipient', async () => {
  const server = transport();
  const view = await open({ client: server.client });
  await mentionAda(view);
  await view.type('#comment-body', 'Ordinary note');
  expect(view.find('[data-mention-clear]')).toBeNull();
  await view.click('[data-comment="post"]');
  expect(server.posts()[0]?.body).not.toHaveProperty('mentions');
});

it('Enter sends an unmatched at-sign query without selecting a person', async () => {
  const server = transport();
  const view = await open({ client: server.client });
  await view.type('#comment-body', '@zz');
  expect(view.text()).toContain('No matching people');
  await key(view, '#comment-body', 'Enter');
  expect(server.posts()).toHaveLength(1);
  expect(server.posts()[0]?.body).toMatchObject({ body: '@zz' });
  expect(server.posts()[0]?.body).not.toHaveProperty('mentions');
});

it.each(['denied', 'unavailable'] as const)(
  'a %s people read offers no names but does not remove comment-only authority',
  async (outcome) => {
    const server = transport();
    server.answers.people = () =>
      outcome === 'denied'
        ? Promise.resolve(refusal('SCOPE_NOT_GRANTED'))
        : Promise.reject(new Error('People offline'));
    const view = await open({ client: server.client });
    await view.type('#comment-body', '@');
    expect(view.find('[role=option]')).toBeNull();
    expect(view.text()).not.toContain('Ada Synthetic');
    expect(view.text()).toContain(outcome === 'denied' ? 'SCOPE_NOT_GRANTED' : 'could not be read');
    await view.type('#comment-body', 'Comment-only note');
    await view.click('[data-comment="post"]');
    expect(server.posts()[0]?.body).not.toHaveProperty('mentions');
  },
);

it.each(['SCOPE_NOT_GRANTED', 'VERSION_STALE', 'MENTION_NOT_READABLE'])(
  'keeps text and recipients when the server refuses %s',
  async (code) => {
    const server = transport();
    server.answers.comment = () => Promise.resolve(refusal(code));
    let posted = 0;
    const view = await open({
      client: server.client,
      posted: () => {
        posted += 1;
      },
    });
    await mentionAda(view);
    await view.type('#comment-body', '@Ada Synthetic Keep this draft');
    await view.click('[data-comment="post"]');
    expect(view.text()).toContain(code);
    expect(view.find('#comment-body')).toHaveProperty('value', '@Ada Synthetic Keep this draft');
    expect(view.find('#comment-body')?.getAttribute('aria-autocomplete')).toBe('list');
    expect(posted).toBe(code === 'VERSION_STALE' ? 1 : 0);
    if (code === 'SCOPE_NOT_GRANTED') {
      expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', true);
    } else {
      await view.render(
        <Harness
          client={server.client}
          revision={7}
          posted={() => {
            posted += 1;
          }}
        />,
      );
      await view.click('[data-comment="post"]');
      expect(server.posts()[1]?.body).toMatchObject({
        expectedRevision: 7,
        mentions: [ADA],
        operationId: '00000000-0000-4000-8000-000000000002',
      });
    }
  },
);

// Authority refusals can withhold a recorded success (envelope.ts:replay/withheldNow).
// Their unknown-outcome custody remains P05 recovery debt, not proof of non-effect.
it.each(['VERSION_STALE', 'MENTION_NOT_READABLE'])(
  'an unknown attempt stays exact until a definitive %s refusal settles it',
  async (code) => {
    const server = transport();
    let calls = 0;
    server.answers.comment = () =>
      ++calls === 1 ? Promise.reject(new Error('Lost answer')) : Promise.resolve(refusal(code));
    const view = await open({ client: server.client });
    await mentionAda(view);
    await view.type('#comment-body', '@Ada Synthetic Held until answered');
    await view.click('[data-comment="post"]');
    expect(view.find('[data-comment="unresolved"]')).not.toBeNull();
    await view.render(<Harness client={server.client} revision={7} />);
    await view.click('[data-comment="post"]');
    expect(server.posts()[1]?.body).toEqual(server.posts()[0]?.body);
    expect(view.find('[data-comment="unresolved"]')).toBeNull();
    expect(view.find('#comment-body')).toHaveProperty(
      'value',
      '@Ada Synthetic Held until answered',
    );
    expect(view.find('#comment-body')?.getAttribute('aria-autocomplete')).toBe('list');
    expect(view.find('#comment-body')).toHaveProperty('disabled', false);
    server.answers.comment = () => Promise.resolve(response({ recordId: 'task-one', revision: 7 }));
    await view.click('[data-comment="post"]');
    expect(server.posts()[2]?.body).toMatchObject({
      body: '@Ada Synthetic Held until answered',
      mentions: [ADA],
      expectedRevision: 7,
      operationId: '00000000-0000-4000-8000-000000000002',
    });
    expect(view.find('#comment-body')).toHaveProperty('value', '');
  },
);

it('a task change retires pending results and the old selection before a new draft is written', async () => {
  const server = transport();
  const delayed = deferredResponse();
  server.answers.comment = () => delayed.promise;
  let posted = 0;
  let refused = 0;
  const view = await open({
    client: server.client,
    posted: () => {
      posted += 1;
    },
    refused: () => {
      refused += 1;
    },
  });
  await mentionAda(view);
  await view.type('#comment-body', '@Ada Synthetic Old task');
  await view.click('[data-comment="post"]');
  await view.render(
    <Harness
      client={server.client}
      recordId="task-two"
      posted={() => {
        posted += 1;
      }}
      refused={() => {
        refused += 1;
      }}
    />,
  );
  expect(view.find('#comment-body')).toHaveProperty('value', '');
  // The new task's composer holds no selected name: a held one, with no
  // occurrence of it in the empty body, would draw Clear mentions.
  expect(view.find('[data-mention-clear]')).toBeNull();
  await view.type('#comment-body', 'New task draft');
  await act(() => {
    delayed.resolve(refusal('SCOPE_NOT_GRANTED'));
  });
  expect(view.find('#comment-body')).toHaveProperty('value', 'New task draft');
  expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', false);
  expect(posted).toBe(0);
  expect(refused).toBe(0);
  // The new task's post carries none of the old task's mention ids.
  server.answers.comment = () => Promise.resolve(response({ recordId: 'task-two', revision: 5 }));
  await view.click('[data-comment="post"]');
  const sent = server.posts().at(-1)?.body;
  expect(sent).toMatchObject({ recordId: 'task-two', body: 'New task draft' });
  expect(sent).not.toHaveProperty('mentions');
});

it('an owner change offers neither old names nor a late old people answer', async () => {
  const alpha = transport();
  const late = deferredResponse();
  alpha.answers.people = () => late.promise;
  const bravo = transport('bravo');
  bravo.answers.people = () => Promise.resolve(refusal('SCOPE_NOT_GRANTED'));
  const view = await open({ client: alpha.client });
  await view.render(<Harness client={bravo.client} />);
  await act(() => {
    late.resolve(response(PEOPLE));
  });
  await settle();
  expect(view.text()).not.toContain('Ada Synthetic');
  expect(view.text()).not.toContain('Bea Synthetic');
  expect(view.find('[data-internal-task-mentions] [role=option]')).toBeNull();
  expect(bravo.posts()).toHaveLength(0);
});

it('All activity has no selection or post; Client never receives an internal mention', async () => {
  const server = transport();
  const view = await open({ client: server.client });
  await mentionAda(view);
  await view.click('[role="tab"][id$="all"]');
  expect(view.find('[data-internal-task-mentions] [role=option]')).toBeNull();
  expect(view.find('[data-comment="post"]')).toHaveProperty('disabled', true);
  await view.click('[role="tab"][id$="client"]');
  expect(view.find('[data-internal-task-mentions] [role=option]')).toBeNull();
  await view.type('#comment-body', 'Client note');
  await view.click('[data-comment="post"]');
  expect(server.posts()[0]?.body).toMatchObject({ audience: 'client', commentType: 'client' });
  expect(server.posts()[0]?.body).not.toHaveProperty('mentions');
});

it('Shift Enter and IME do not post; Enter posts the selected internal mention once', async () => {
  const server = transport();
  const view = await open({ client: server.client });
  await mentionAda(view);
  await view.type('#comment-body', '@Ada Synthetic Typed note');
  await key(view, '#comment-body', 'Enter', { shiftKey: true });
  await key(view, '#comment-body', 'Enter', { isComposing: true });
  expect(server.posts()).toHaveLength(0);
  await key(view, '#comment-body', 'Enter');
  expect(server.posts()).toHaveLength(1);
  expect(server.posts()[0]?.body).toMatchObject({ mentions: [ADA] });
});
