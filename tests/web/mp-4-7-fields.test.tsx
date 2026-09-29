// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-7, the dock task panel's two fields (CS-4.23, CS-4.24, DP-34, DP-35):
// each writes its text whole through `task.update` against the revision it
// was read at. Leaving the field or Ctrl/Cmd+Enter saves a change, Escape
// puts the saved text back, an emptied field clears the value, and a refused
// save keeps the typing and quotes the server.

import { afterEach, describe, expect, it } from 'vitest';
import { BriefField, DescriptionField } from '../../apps/web/src/screens/task/Writing.tsx';
import { TASK_ID } from './task-page-stub.tsx';
import { mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { BRIEF, blur, field, pressWith, settleWrites, textOf } from './writing-support.tsx';

afterEach(async () => {
  await unmountAll();
});

describe('MP-4-7 CS-4.24 write the description', () => {
  it('a changed description is saved on leaving the field, against the revision it was read at', async () => {
    const { sent, saved, client, onSaved } = field();
    const view = await mount(
      <DescriptionField
        client={client}
        recordId={TASK_ID}
        revision={4}
        value="old"
        onSaved={onSaved}
      />,
    );
    await typeInto(view, 'textarea[data-writing="description"]', 'Fix the pacing.');
    await blur(view, 'textarea[data-writing="description"]');
    await settleWrites();
    expect(sent).toMatchObject([
      { recordId: TASK_ID, expectedRevision: 4, fields: { description: 'Fix the pacing.' } },
    ]);
    expect(saved).toHaveLength(1);
  });

  it('Ctrl or Cmd and Enter saves; Escape puts the saved text back and sends nothing', async () => {
    const { sent, client, onSaved } = field();
    const view = await mount(
      <DescriptionField
        client={client}
        recordId={TASK_ID}
        revision={4}
        value="old"
        onSaved={onSaved}
      />,
    );
    const at = 'textarea[data-writing="description"]';
    await typeInto(view, at, 'typed');
    await press(view, at, 'Escape');
    expect(textOf(view, at)).toBe('old');
    await blur(view, at);
    await settleWrites();
    expect(sent).toStrictEqual([]);
    await typeInto(view, at, 'sent');
    await pressWith(view, at, { key: 'Enter', metaKey: true });
    await settleWrites();
    expect(sent).toMatchObject([{ fields: { description: 'sent' } }]);
  });
});

describe('MP-4-7 CS-4.24 write the description: clearing and refusal', () => {
  it('an emptied description is cleared, not saved as blank text; an unchanged one sends nothing', async () => {
    const { sent, client, onSaved } = field();
    const view = await mount(
      <DescriptionField
        client={client}
        recordId={TASK_ID}
        revision={4}
        value="old"
        onSaved={onSaved}
      />,
    );
    const at = 'textarea[data-writing="description"]';
    await blur(view, at);
    await settleWrites();
    expect(sent).toStrictEqual([]);
    await typeInto(view, at, '  ');
    await blur(view, at);
    await settleWrites();
    expect(sent).toMatchObject([{ fields: { description: null } }]);
  });

  it('a refused save keeps the typing and quotes the server', async () => {
    const refusal = {
      refused: true,
      code: 'SCOPE_NOT_GRANTED',
      names: ['task:write'],
      fixes: ['Ask for write on this task.'],
    };
    const { saved, client, onSaved } = field({ status: 403, body: refusal });
    const view = await mount(
      <DescriptionField
        client={client}
        recordId={TASK_ID}
        revision={4}
        value="old"
        onSaved={onSaved}
      />,
    );
    const at = 'textarea[data-writing="description"]';
    await typeInto(view, at, 'mine');
    await blur(view, at);
    await settleWrites();
    expect(textOf(view, at)).toBe('mine');
    expect(view.find('[role="alert"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(saved).toStrictEqual([]);
  });
});

describe('MP-4-7 CS-4.23 write the agent brief', () => {
  it('the brief field writes agent_brief, whole, on leaving it', async () => {
    const { sent, saved, client, onSaved } = field();
    const view = await mount(
      <BriefField client={client} recordId={TASK_ID} revision={7} value={null} onSaved={onSaved} />,
    );
    await typeInto(view, 'textarea[data-writing="brief"]', BRIEF);
    await blur(view, 'textarea[data-writing="brief"]');
    await settleWrites();
    expect(sent).toMatchObject([
      { recordId: TASK_ID, expectedRevision: 7, fields: { agent_brief: BRIEF } },
    ]);
    expect(Object.keys((sent[0]?.['fields'] ?? {}) as object)).toStrictEqual(['agent_brief']);
    expect(saved).toHaveLength(1);
  });
});
