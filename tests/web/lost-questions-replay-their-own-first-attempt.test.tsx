// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-promise-executor-return -- the review's proof, kept as written */
//
// #897: the drawer over the stand-in register (`resend-fixture.tsx`). Two
// lost later questions each keep their identity; a late lost replay never
// brings back an identity its own retry ended; a replayed edit proposal keeps
// the revision its question first read; a lost first question keeps its start
// identity after a different question starts the tab. Moved from the
// review's proof; the last case's start count is the exact sequence (A, B,
// then A replayed), because the replay is itself a start send.
import { afterEach, expect, it } from 'vitest';
import { resends, type Asked } from '../../apps/web/src/assistant/resend.ts';
import type { CallResult } from '../../apps/web/src/operations/client.ts';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { EDIT, REPLY } from '../surfaces/chat-proposal-drawer.tsx';
import { drawer, standIn, identities, TASK } from './resend-fixture.tsx';
afterEach(unmountAll);

it('a second lost question replays without another durable question or model call', async () => {
  const api = standIn({ 'conversation.message': ['drop', 'drop'] });
  await (
    await drawer(api.client)
  )('First', 'A', 'B', 'B', 'A');
  const sent = identities(api.sent, 'conversation.message');
  expect(sent[2]).toBe(sent[1]);
  expect(sent[3]).toBe(sent[0]);
  expect(api.committed).toHaveLength(3);
});

it('a late lost replay cannot resurrect an identity whose retry already succeeded', async () => {
  const tab = resends();
  const asked: Asked = { command: 'conversation.start', question: 'A', request: { body: 'A' } };
  const ids: string[] = [];
  const pending: ((v: CallResult<unknown>) => void)[] = [];
  const write = async (_r: Asked['request'], id: string) => {
    ids.push(id);
    return await new Promise<CallResult<unknown>>((resolve) => pending.push(resolve));
  };
  const lost = { unavailable: true, because: 'lost' } as const;
  const done = { ok: true, value: {} } as const;
  const first = tab.send('tab', asked, write);
  pending[0]!(lost);
  await first;
  const late = tab.send('tab', asked, write);
  const quick = tab.send('tab', asked, write);
  pending[2]!(done);
  await quick;
  pending[1]!(lost);
  await late;
  const again = tab.send('tab', asked, write);
  pending[3]!(done);
  await again;
  expect(ids.slice(0, 3)).toEqual([ids[0], ids[0], ids[0]]);
  expect(ids[3]).not.toBe(ids[0]);
});

it('replayed edit proposals keep the task revision their original question read', async () => {
  let revision = 7;
  const api = standIn(
    { 'conversation.start': ['drop'] },
    {},
    {
      revision: () => revision,
      reply: () => ({ answered: true, messageId: REPLY, body: EDIT, cites: [] }),
    },
  );
  const ask = await drawer(api.client);
  await ask('Tighten');
  revision = 8;
  await ask('Tighten');
  const kept = JSON.parse(
    sessionStorage.getItem('ops-astro:proposal-baselines:resend-proof') ?? '{}',
  );
  expect(kept[REPLY]).toEqual({ taskId: TASK.id, revision: 7 });
});

it('a lost first question retains its start identity after a different question starts the tab', async () => {
  const api = standIn({ 'conversation.start': ['drop'] });
  await (
    await drawer(api.client)
  )('Question A', 'Question B', 'Question A');
  const starts = identities(api.sent, 'conversation.start');
  expect(starts).toEqual([starts[0], starts[1], starts[0]]);
  expect(new Set(starts).size).toBe(2);
  expect(
    api.committed,
    'A and B each commit once; resending unchanged A must replay its original attempt',
  ).toHaveLength(2);
  expect(api.sent.at(-1)?.operationId).toBe(starts[0]);
});
