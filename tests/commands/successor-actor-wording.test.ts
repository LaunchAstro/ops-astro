// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a successor is proposed by, in words that fit whoever asked (thermo
// review b483399, O5).
//
// A person hands a lease back on `/api/p` through the same successor reader
// the agent entry uses, so a body naming its own proposer is refused to both
// in one wording, and that wording names the session's actor rather than an
// agent a person does not have.
//
// The refusal is decided before any statement, so the transaction is a stub.
// This suite moves the database counter by zero, so it is a unit suite and
// must not be named in `tests/db/named-suites.json`.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandContext } from '../../packages/core-records/src/commands/context.ts';
import {
  handbackLease,
  handbackOwnLease,
} from '../../packages/core-records/src/commands/tasks-handback.ts';

const ACTOR = '33333333-3333-4333-8333-333333333333';

const untouched: TenantQuery = {
  businessId: '11111111-1111-4111-8111-111111111111',
  query: () => {
    throw new Error('reached the database');
  },
};

const person = {
  session: { personId: randomUUID(), actorId: ACTOR, roleKey: 'owner' },
  declaration: { collection: 'task' },
} as unknown as CommandContext;

const fields = {
  leaseId: randomUUID(),
  fence: 1,
  outcome: 'completed',
  successor: { purpose: 'next', proposedByActorId: randomUUID() },
};

const REFUSAL = {
  refused: true,
  code: 'FIELD_NOT_WRITABLE',
  names: ['successor.proposedByActorId'],
  fixes: [
    'The successor is recorded as proposed by the actor of your session, and that is not a field a body may send: remove it and send the request again.',
    'A body that could name the proposing actor could record a proposal as somebody else’s, which is the claim this boundary exists to refuse.',
  ],
};

describe('a successor that names its own proposer', () => {
  it('is refused to a person in words that name no agent', async () => {
    const outcome = await handbackOwnLease(untouched, person, fields);
    expect('refusal' in outcome && outcome.refusal).toStrictEqual(REFUSAL);
  });

  it('is refused to an agent in the same bytes', async () => {
    const outcome = await handbackLease(untouched, fields, ACTOR);
    expect('refusal' in outcome && outcome.refusal).toStrictEqual(REFUSAL);
  });
});
