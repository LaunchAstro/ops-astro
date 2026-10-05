// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { ADA, NEW_ID, NEW_KEY, draft, store } from './draft-support.tsx';
import { json, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { readDraft } from '../../apps/web/src/screens/task/task-draft.ts';

afterEach(unmountAll);

function notSent(): never {
  throw new Error('Create was not sent');
}

// Sol OW-089.1 criterion 5, retitled by what it proves; its body is Sol's.
it('edits accepted during Create are not discarded by its response', async () => {
  let answer: ((response: Response) => void) | undefined;
  const sent: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return await new Promise<Response>((resolve) => {
      answer = resolve;
    });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const storage = store();
  const { view } = await draft({ client, storage });
  await typeInto(view, '#panel-draft-name', 'Original title');
  await view.click('[data-draft="create"]');
  await tick();
  expect(sent).toHaveLength(1);
  const field = view.host.querySelector<HTMLInputElement>('#panel-draft-name');
  expect(field).not.toBeNull();
  // If the UI locks the fields, no edit is accepted and this race is closed.
  if (field?.disabled || field?.readOnly) {
    answer?.(json({ recordId: 'new-task', revision: 1, detail: { key: 'New-task' } }));
    await tick();
    return;
  }
  await typeInto(view, '#panel-draft-name', 'Later title accepted during Create');
  expect(storage.getItem('ops-astro.task-draft.alpha:ada@example.test') ?? '').toContain(
    'Later title',
  );
  answer?.(json({ recordId: 'new-task', revision: 1, detail: { key: 'New-task' } }));
  await tick();
  // The request contained the original title. The later edit must remain recoverable.
  expect(sent[0]?.['fields']).toEqual({ title: 'Original title' });
  expect(storage.getItem('ops-astro.task-draft.alpha:ada@example.test') ?? '').toContain(
    'Later title',
  );
});

// Sol OW-090.1 criterion 5, retitled by what it proves; its body is Sol's.
it('an edit accepted while draft Create is in flight is not silently discarded', async () => {
  let answer: (response: Response) => void = notSent;
  const bodies: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return await new Promise<Response>((resolve) => {
      answer = resolve;
    });
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: transport,
  });
  const storage = store();
  const opened = await draft({ client, storage });
  await typeInto(opened.view, '#panel-draft-name', 'Original title');
  await opened.view.click('[data-draft="create"]');
  expect(bodies).toHaveLength(1);
  const name = opened.view.host.querySelector<HTMLInputElement>('#panel-draft-name');
  expect(name).not.toBeNull();
  const editable = name !== null && !name.disabled && !name.readOnly;
  if (editable) {
    await typeInto(opened.view, '#panel-draft-name', 'Revised title');
    expect(readDraft(storage, ADA)?.title).toBe('Revised title');
  }
  await act(() => {
    answer(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
  });
  await tick();
  const sentFields = bodies[0]?.['fields'] as Record<string, unknown>;
  const revisionWasWritten = sentFields['title'] === 'Revised title';
  const revisionWasKept = readDraft(storage, ADA)?.title === 'Revised title';
  expect(
    !editable || revisionWasWritten || revisionWasKept,
    'The accepted edit was neither sent nor retained',
  ).toBe(true);
});
