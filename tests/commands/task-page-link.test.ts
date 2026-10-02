// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-12: the page link (CS-4.22, DP-29, DP-30). A task links to the page it
// is about: an in-product address, its path and hash, stored as the task's
// `page_link` (unslotted, display only: the fixed-slots contract's line on
// the legacy field) and written through `task.update` under `task:write`, so
// it joins the audit chain as that command. Only an address inside the product
// is kept: a scheme, another host, a backslash or a control character is
// refused and nothing is stored, because the panel draws the link as a door.
// The pin (CS-4.7) is a person's preference and waits on the preference model.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  CANARY,
  alpha,
  as,
  auditOf,
  bravo,
  bravoEditor,
  clientA,
  clientAEditor,
  clientB,
  db,
  edit,
  editor,
  fresh,
  outcomeOf,
  readAs,
  reader,
  serverUrl,
  setUp,
  tearDown,
} from './panel-fields-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-page-link: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp('hl');
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

const stored = async (recordId: string): Promise<unknown> =>
  (
    await db.admin.execute<{ readonly link: unknown }>(
      `select data -> 'page_link' as link from public.records where id = $1`,
      [recordId],
    )
  )[0]?.link ?? null;

const linkRead = async (recordId: string): Promise<unknown> => {
  const read = await readAs(alpha, reader, recordId);
  return isCommandRefusal(read) || !('task' in read) ? 'refused' : read.task.pageLink;
};

describe.skipIf(serverUrl === undefined)('MP-4-12 CS-4.22 link set', () => {
  it('links the task to the section being read, re-points it and clears it', async () => {
    const id = await fresh(alpha, editor, 'linked');
    expect(await linkRead(id)).toBeNull();
    const set = await edit(alpha, editor, 'task.update', id, { page_link: '/clients/acme#brief' });
    expect(outcomeOf(set)).toStrictEqual({ applied: true });
    expect(await linkRead(id)).toBe('/clients/acme#brief');
    await edit(alpha, editor, 'task.update', id, { page_link: '/boards/website?view=list#row-4' });
    expect(await linkRead(id)).toBe('/boards/website?view=list#row-4');
    await edit(alpha, editor, 'task.update', id, { page_link: null });
    expect(await linkRead(id)).toBeNull();
  });

  it('MP-4-12 refusal task:write: a reader links nothing', async () => {
    const id = await fresh(alpha, editor, 'unlinked');
    const refused = await edit(alpha, reader, 'task.update', id, { page_link: '/clients/acme' });
    expect(outcomeOf(refused)).toStrictEqual({ code: 'SCOPE_NOT_GRANTED' });
    expect(await stored(id)).toBeNull();
  });

  it('MP-4-12 audit readback: a link set joins the chain as task.update; a refusal as refused', async () => {
    const id = await fresh(alpha, editor, 'audited link');
    const ops = [randomUUID(), randomUUID()];
    await edit(alpha, editor, 'task.update', id, { page_link: '/clients/acme' }, ops[0]);
    await edit(alpha, reader, 'task.update', id, { page_link: '/elsewhere' }, ops[1]);
    expect(JSON.parse(JSON.stringify(await auditOf(ops)))).toStrictEqual([
      {
        command: 'task.update',
        actor_id: editor.actorId,
        outcome: 'applied',
        refusal_code: null,
        subject_record_id: id,
      },
      {
        command: 'task.update',
        actor_id: reader.actorId,
        outcome: 'refused',
        refusal_code: 'SCOPE_NOT_GRANTED',
        subject_record_id: null,
      },
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-12 link stays in the product', () => {
  it.each([
    ['another site', 'https://example.test/x'],
    ['a scheme in any case', 'JaVaScRiPt:alert(1)'],
    ['a data address', 'data:text/html,hi'],
    ['a host-relative address', '//example.test/x'],
    ['a backslash after the slash', '/\\example.test'],
    ['a backslash anywhere', '/clients\\acme'],
    ['a tab the address parser drops', '/\t/example.test'],
    ['a line break', '/clients/acme\n'],
    ['a leading space', ' /clients/acme'],
    ['a relative path', 'clients/acme'],
    ['an empty address', ''],
    ['an address too long to be one', `/${'a'.repeat(2048)}`],
    ['a number', 42],
  ])('refuses %s and stores nothing', async (_name, link) => {
    const id = await fresh(alpha, editor, 'guarded');
    const answer = await edit(alpha, editor, 'task.update', id, { page_link: link });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID' });
    expect(await stored(id)).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-12 link stays in the product', () => {
  it('task.create refuses a link out of the product and creates nothing', async () => {
    const title = `made-${randomUUID()}`;
    const answer = await as(alpha, editor, {
      command: 'task.create',
      fields: { title, page_link: '//example.test/x' },
    });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID' });
    const made = await db.admin.execute(`select 1 from public.records where txt_4 = $1`, [title]);
    expect(made).toHaveLength(0);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-12 isolation', () => {
  it('another business: its task is not found, nothing of it is echoed, and it gains no link', async () => {
    const foreign = await fresh(bravo, bravoEditor, CANARY);
    const answer = await edit(alpha, editor, 'task.update', foreign, { page_link: '/reached' });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'NOT_FOUND' });
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(await stored(foreign)).toBeNull();
  });

  it('another client in the same business: client A’s editor links client A’s task and not client B’s', async () => {
    const taskA = await fresh(alpha, editor, 'client A work', clientA);
    const taskB = await fresh(alpha, editor, CANARY, clientB);
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientAEditor, 'read', { kind: 'record', id: taskA });
      await grantTo(tx, clientAEditor, 'write', { kind: 'record', id: taskA });
    });
    const own = await edit(alpha, clientAEditor, 'task.update', taskA, { page_link: '/a' });
    expect(outcomeOf(own)).toStrictEqual({ applied: true });
    const cross = await edit(alpha, clientAEditor, 'task.update', taskB, { page_link: '/b' });
    expect(outcomeOf(cross)).toStrictEqual({ code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(cross)).not.toContain(CANARY);
    expect(await stored(taskB)).toBeNull();
  });
});
