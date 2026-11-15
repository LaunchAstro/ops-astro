// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite: the plan, the text checks, then each refused send */
//
// The demo data's safeguards (scripts/ops/demo-data-checks.ts, #2211, register 253):
// the plan passes its own checks, and every forbidden send is refused before
// it leaves, so the stand-in transport below records nothing for it.

import { describe, expect, it } from 'vitest';
import {
  guarded,
  planProblems,
  reservedHost,
  textProblems,
  type Body,
  type Send,
} from '../../scripts/ops/demo-data-checks.ts';

// Addresses built from parts, so the published text holds none the public-content check refuses.
const at = (local: string, domain: string): string => [local, domain].join('@');

const OURS = '7d1f2a3b-0000-4000-8000-000000000001';
const GATE = '7d1f2a3b-0000-4000-8000-000000000002';

function recorder(): { readonly sent: string[]; readonly send: Send } {
  const sent: string[] = [];
  return {
    sent,
    send: guarded(
      (verb) => {
        sent.push(verb);
        return Promise.resolve({ status: 200, body: {} });
      },
      new Set([OURS]),
      new Set([GATE]),
    ),
  };
}

describe('demo data safeguards', () => {
  it('the demo plan has no unreserved address, phone-like number or unnamed record', () => {
    expect(planProblems()).toStrictEqual([]);
  });

  it('only example.com, .net, .org and .test hosts are reserved', () => {
    for (const host of ['example.com', 'a.example.org', 'clinic.test', 'B.EXAMPLE.NET.']) {
      expect(reservedHost(host)).toBe(true);
    }
    for (const host of [
      'agencyastro.com',
      'example.com.au',
      'notexample.com',
      'test.com',
      'gmail.com',
    ]) {
      expect(reservedHost(host)).toBe(false);
    }
  });

  it('a real address, a real website or a phone number in text is a problem', () => {
    expect(textProblems(`write to ${at('sam', 'clinic.com.au')}`)).toHaveLength(1);
    expect(textProblems('see https://www.agencyastro.com/about')).toHaveLength(1);
    expect(textProblems('call 555 0100 999')).toHaveLength(1);
    expect(textProblems('call (555) 0100-77')).toHaveLength(1);
    expect(
      textProblems(`Sam <${at('sam', 'clinic.example.com')}>, https://clinic.example.com`),
    ).toStrictEqual([]);
    expect(textProblems('no call-out fee before 5pm, 3 posts over 2 weeks')).toStrictEqual([]);
  });

  const refusals: readonly (readonly [string, string, Body])[] = [
    ['a command outside the list', 'task.assign', { recordId: OURS, expectedRevision: 1 }],
    ['a launch', 'task.launch', { recordId: OURS }],
    ['an invitation', 'invitation.create', { email: 'a@example.com' }],
    ['a delete outside the list', 'task.purge', {}],
    [
      'a write to a record it did not make',
      'task.start',
      { recordId: 'f'.repeat(8), expectedRevision: 1 },
    ],
    [
      'a mention',
      'task.comment',
      { recordId: OURS, expectedRevision: 1, body: 'hi', audience: 'internal', mentions: [] },
    ],
    [
      'a client-audience comment',
      'task.comment',
      { recordId: OURS, expectedRevision: 1, body: 'hi', audience: 'client' },
    ],
    ['an assignee field', 'task.create', { fields: { title: 'Demo x', assignee: OURS } }],
    [
      'a page link',
      'task.create',
      { fields: { title: 'Demo x', page_link: 'https://clinic.example.com' } },
    ],
    [
      'a real address in a body',
      'task.create',
      { fields: { title: 'Demo x', description: at('jo', 'gmail.com') } },
    ],
    [
      'a phone number in a body',
      'task.comment',
      { recordId: OURS, expectedRevision: 1, body: 'ring 555 0100 999', audience: 'internal' },
    ],
    [
      'a ceiling over AUD 5',
      'task.propose',
      { recordId: OURS, expectedRevision: 1, maximumMinor: 501, step: { kind: 'demo_plan' } },
    ],
    [
      "the worker's own step",
      'task.propose',
      {
        recordId: OURS,
        expectedRevision: 1,
        maximumMinor: 100,
        step: { kind: 'synthetic_comment' },
      },
    ],
    [
      'a decision on a gate it did not open',
      'task.decide',
      { gateId: 'f'.repeat(8), versionId: 'v', decision: 'approve' },
    ],
    ['a thread on no demo task', 'conversation.start', { body: 'hi', title: 'Demo t' }],
    [
      'a thread naming a model',
      'conversation.start',
      { body: 'hi', scope: { kind: 'task', id: OURS }, model: 'gpt' },
    ],
  ];

  it.each(refusals)('refuses %s and sends nothing', async (_why, verb, body) => {
    const { sent, send } = recorder();
    await expect(send(verb, body)).rejects.toThrow(verb);
    expect(sent).toStrictEqual([]);
  });

  it('sends an allowed write on its own record, with ids and dates not read as phone numbers', async () => {
    const { sent, send } = recorder();
    await send('task.start', {
      operationId: 'demo-data:123456789abc:task:0:start',
      recordId: OURS,
      expectedRevision: 2,
    });
    await send('task.create', { fields: { title: 'Demo x', due: '2026-10-27T05:00:00.000Z' } });
    await send('task.decide', {
      gateId: GATE,
      versionId: 'v',
      decision: 'approve',
      note: 'Demo approval',
    });
    expect(sent).toStrictEqual(['task.start', 'task.create', 'task.decide']);
  });
});
