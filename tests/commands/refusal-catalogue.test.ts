// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal catalogue, pinned as it stood at b282216.
//
// Written before the catalogue was folded into one table (architecture review
// bbdf2b2, candidate 2), and green before and after. Two things are pinned:
// every registered code with its status and visibility, in register order,
// plus the twenty the runtime calls its own; and the exact bytes of one
// refusal from each road a refusal takes to a caller. A refactor that moved a
// status, dropped a code, reordered a fix or renamed a key fails here before
// any caller sees it.
//
// This suite moves the database counter by zero, so it is a unit suite and
// must not be named in `tests/db/named-suites.json`.

import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { createApi } from '../../apps/api/app.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { statusFor } from '../../apps/api/status.ts';
import {
  refuse as refuseRuntime,
  SUGGESTED_STATUS,
} from '../../packages/core-runtime/src/refusals.ts';
import { REFUSAL_REGISTER } from '../../packages/core-records/src/commands/register.ts';
import {
  asCallerVisible,
  fromAgentIdentity,
  fromAuthority,
  fromIdentity,
  fromRecords,
  refuseCommand,
  refuseNotFound,
  type CommandRefusal,
} from '../../packages/core-records/src/commands/refusal.ts';
import {
  fromRuntime,
  handbackLease,
} from '../../packages/core-records/src/commands/tasks-runtime.ts';
import { isRefused } from '../../packages/core-records/src/commands/outcome.ts';
import { refuse as refuseRecords } from '../../packages/core-records/src/records/refusals.ts';
import {
  refuse as refuseIdentity,
  refuseAgent,
} from '../../packages/core-records/src/identity/refusals.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

/** Every registered code, its HTTP status and its visibility, in register order. */
const CATALOGUE: readonly (readonly [string, number, 'caller' | 'audit'])[] = [
  ['AUTH_UNKNOWN_LOGIN', 401, 'caller'],
  ['AUTH_NO_MEMBERSHIP', 403, 'caller'],
  ['ACTOR_INACTIVE', 403, 'caller'],
  ['SCOPE_NOT_GRANTED', 403, 'caller'],
  ['GRANT_WIDENS', 403, 'caller'],
  ['GRANT_DEEPENS', 403, 'caller'],
  ['NOT_FOUND', 404, 'caller'],
  ['FIELD_NOT_SLOTTED', 422, 'caller'],
  ['FIELD_NOT_GROUPABLE', 422, 'caller'],
  ['FIELD_UNKNOWN', 422, 'caller'],
  ['FIELD_NOT_WRITABLE', 422, 'caller'],
  ['VIEW_HOP_LIMIT', 422, 'caller'],
  ['SLOT_RESERVED', 422, 'caller'],
  ['SLOT_TYPE_EXHAUSTED', 422, 'caller'],
  ['SLOT_INDEX_ABSENT', 422, 'caller'],
  ['SLOT_UNKNOWN', 422, 'caller'],
  ['TRANSITION_PROTECTED', 422, 'caller'],
  ['PLACEMENT_IS_DERIVED', 422, 'caller'],
  ['PARENT_TRASHED', 409, 'caller'],
  ['ALREADY_TRASHED', 409, 'caller'],
  ['UNIQUE_VALUE_TAKEN', 409, 'caller'],
  ['RETENTION_CLASS_PROTECTED', 403, 'caller'],
  ['OPERATION_ID_REQUIRED', 422, 'caller'],
  ['EXPECTED_REVISION_REQUIRED', 422, 'caller'],
  ['OPERATION_ID_REUSED', 409, 'caller'],
  ['VERSION_STALE', 409, 'caller'],
  ['SOURCE_SPOOFED', 403, 'caller'],
  ['FIELD_VALUE_INVALID', 422, 'caller'],
  ['TRANSITION_NOT_PERMITTED', 409, 'caller'],
  ['DEPENDENCY_NOT_LANDED', 501, 'caller'],
  ['COMMAND_BODY_INVALID', 400, 'caller'],
  ['WRONG_BUSINESS', 404, 'audit'],
  ['AUTH_NO_AGENT_IDENTITY', 401, 'caller'],
  ['AUTH_SESSION_EXPIRED', 401, 'caller'],
  ['DELEGATION_EXCLUDES_OPERATION', 403, 'caller'],
  ['DELEGATION_EXCLUDES_DECISION', 403, 'caller'],
  ['DELEGATION_EXCLUDES_INTAKE', 403, 'caller'],
  ['DELEGATION_NARROWED', 403, 'caller'],
  ['DELEGATION_OUT_OF_PURPOSE', 403, 'caller'],
  ['DELEGATION_NOT_LIVE', 401, 'caller'],
  ['DELEGATION_WIDENS', 403, 'caller'],
  ['DELEGATION_ALREADY_LIVE', 409, 'caller'],
  ['DELEGATION_EXPIRED', 403, 'caller'],
  ['DELEGATION_REVOKED', 403, 'caller'],
  ['LEASE_HELD', 409, 'caller'],
  ['LEASE_EXPIRED', 410, 'caller'],
  ['LEASE_NOT_OWNED', 403, 'caller'],
  ['TASK_NOT_PICKABLE', 409, 'caller'],
  ['AUDIENCE_NOT_PERMITTED', 422, 'caller'],
  ['PRESET_FIELD_UNCLASSIFIED', 422, 'caller'],
  ['PRESET_TYPE_UNKNOWN', 404, 'caller'],
  ['PRESET_FIELD_UNPLACEABLE', 409, 'caller'],
  ['PRESET_FIELD_DUPLICATE', 422, 'caller'],
  ['GATE_PENDING', 409, 'caller'],
  ['GATE_ALREADY_DECIDED', 409, 'caller'],
  ['GATE_NOT_APPROVED', 409, 'caller'],
  ['PROPOSAL_SUPERSEDED', 409, 'caller'],
  ['PROPOSAL_SCOPE_EXCEEDED', 422, 'caller'],
  ['FOUR_EYES_REQUIRED', 409, 'caller'],
  ['BUDGET_UNAVAILABLE', 409, 'caller'],
  ['BUDGET_EXHAUSTED', 402, 'caller'],
  ['VERSION_SUPERSEDED', 409, 'caller'],
  ['EVIDENCE_MISMATCH', 409, 'caller'],
  ['GATE_NOT_FOUND', 404, 'caller'],
  ['GATE_EXPIRED', 410, 'caller'],
  ['LINEAGE_TERMINAL', 409, 'caller'],
  ['CHANGE_ROUNDS_EXHAUSTED', 409, 'caller'],
  ['PROPOSAL_OUT_OF_SCOPE', 403, 'caller'],
  ['RESERVATION_NOT_CLAIMABLE', 409, 'caller'],
  ['LINEAGE_NOT_ON_TASK', 409, 'caller'],
  ['CAP_BINDING_MISMATCH', 409, 'caller'],
  ['ACTUAL_EXPENDITURE_UNSUPPORTED', 422, 'caller'],
  ['SUCCESSOR_OUT_OF_BOUNDS', 409, 'caller'],
];

/** The runtime's own twenty, as `core-runtime` names them. */
const RUNTIME = [
  'ACTUAL_EXPENDITURE_UNSUPPORTED',
  'BUDGET_EXHAUSTED',
  'BUDGET_UNAVAILABLE',
  'CAP_BINDING_MISMATCH',
  'CHANGE_ROUNDS_EXHAUSTED',
  'EVIDENCE_MISMATCH',
  'GATE_ALREADY_DECIDED',
  'GATE_EXPIRED',
  'GATE_NOT_FOUND',
  'LEASE_EXPIRED',
  'LEASE_HELD',
  'LEASE_NOT_OWNED',
  'LINEAGE_NOT_ON_TASK',
  'LINEAGE_TERMINAL',
  'PROPOSAL_OUT_OF_SCOPE',
  'RESERVATION_NOT_CLAIMABLE',
  'SCOPE_NOT_GRANTED',
  'SUCCESSOR_OUT_OF_BOUNDS',
  'TRANSITION_NOT_PERMITTED',
  'VERSION_SUPERSEDED',
];

describe('the refusal catalogue', () => {
  it('registers the same codes, in the same order, under the same status and visibility', () => {
    expect(
      REFUSAL_REGISTER.map((row) => [row.code, statusFor(row.code), row.visibility]),
    ).toStrictEqual(CATALOGUE);
  });

  it('names the same twenty as the runtime’s own, each under its register status', () => {
    expect(Object.keys(SUGGESTED_STATUS).toSorted()).toStrictEqual(RUNTIME);
    for (const [code, status] of Object.entries(SUGGESTED_STATUS)) {
      expect(status, code).toBe(CATALOGUE.find(([listed]) => listed === code)?.[1]);
    }
  });
});

/** What `apps/api/app.ts` puts on the wire for a command refusal. */
const wire = (refusal: CommandRefusal): readonly [number, string] => [
  statusFor(refusal.code),
  JSON.stringify({
    refused: true,
    code: refusal.code,
    names: refusal.names,
    fixes: refusal.fixes,
  }),
];

/** Every key of the shaped refusal, in order, so a stray or reordered key is seen. */
const keys = (refusal: CommandRefusal): string => JSON.stringify(refusal);

const untouched = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`reached the database at .${String(property)}`);
    },
  },
) as unknown as TenantQuery;

describe('one refusal from each road, byte for byte', () => {
  it('a runtime refusal: reason then fix, into fixes', () => {
    const result = refuseRuntime('LEASE_EXPIRED', 'The lease ended.', 'Pick the work up again.');
    if (result.ok) throw new Error('unreachable');
    const shaped = fromRuntime(result.refusal);
    expect(keys(shaped)).toBe(
      '{"refused":true,"code":"LEASE_EXPIRED","names":[],"fixes":["The lease ended.","Pick the work up again."]}',
    );
    expect(wire(shaped)).toStrictEqual([
      410,
      '{"refused":true,"code":"LEASE_EXPIRED","names":[],"fixes":["The lease ended.","Pick the work up again."]}',
    ]);
  });

  it('a delegation refusal the runtime passes through', () => {
    const shaped = fromRuntime({
      code: 'DELEGATION_NOT_LIVE',
      reason: 'The delegation is over.',
      fix: 'Ask again.',
    });
    expect(wire(shaped)).toStrictEqual([
      401,
      '{"refused":true,"code":"DELEGATION_NOT_LIVE","names":[],"fixes":["The delegation is over.","Ask again."]}',
    ]);
  });

  it('an authority refusal', () => {
    const shaped = fromAuthority({
      code: 'SCOPE_NOT_GRANTED',
      reason: 'No grant covers this.',
      fix: 'Ask for one.',
    });
    expect(keys(shaped)).toBe(
      '{"refused":true,"code":"SCOPE_NOT_GRANTED","names":[],"fixes":["No grant covers this.","Ask for one."]}',
    );
    expect(wire(shaped)[0]).toBe(403);
  });

  it('a records refusal keeps its names', () => {
    const shaped = fromRecords(refuseRecords('FIELD_UNKNOWN', ['colour'], ['Use a field it has.']));
    expect(wire(shaped)).toStrictEqual([
      422,
      '{"refused":true,"code":"FIELD_UNKNOWN","names":["colour"],"fixes":["Use a field it has."]}',
    ]);
  });

  it('an identity refusal, person and agent, carries no names', () => {
    expect(wire(fromIdentity(refuseIdentity('ACTOR_INACTIVE', ['Ask an admin.'])))).toStrictEqual([
      403,
      '{"refused":true,"code":"ACTOR_INACTIVE","names":[],"fixes":["Ask an admin."]}',
    ]);
    expect(
      wire(fromAgentIdentity(refuseAgent('AUTH_SESSION_EXPIRED', ['Sign in again.']))),
    ).toStrictEqual([
      401,
      '{"refused":true,"code":"AUTH_SESSION_EXPIRED","names":[],"fixes":["Sign in again."]}',
    ]);
  });

  it('an audit-only code leaves as the NOT_FOUND a fabricated identifier gets', () => {
    const hidden = asCallerVisible(refuseCommand('WRONG_BUSINESS', ['task'], ['other']));
    expect(wire(hidden)).toStrictEqual(wire(refuseNotFound()));
    expect(wire(hidden)).toStrictEqual([
      404,
      '{"refused":true,"code":"NOT_FOUND","names":[],"fixes":["Check the identifier against the one you were given.","If you believe it exists, ask someone who can already see it to share it with you."]}',
    ]);
  });

  it('a command refusal minted in a handler', async () => {
    const outcome = await handbackLease(
      untouched,
      {
        leaseId: '3f1d2f3a-0000-4000-8000-000000000001',
        fence: 1,
        outcome: 'completed',
        actualMinor: 0,
      },
      '3f1d2f3a-0000-4000-8000-0000000000a9',
    );
    if (!isRefused(outcome)) throw new Error('unreachable');
    expect(wire(outcome.refusal)[0]).toBe(422);
    expect(keys(outcome.refusal)).toMatch(
      /^\{"refused":true,"code":"ACTUAL_EXPENDITURE_UNSUPPORTED","names":\["actualMinor"\],"fixes":\[/u,
    );
  });
});

const SECRET = 'a-local-test-secret-that-is-not-the-running-one';
const ALPHA = '11111111-1111-4111-8111-111111111111';
const MIA = '22222222-2222-4222-8222-222222222222';

/** Answers the boundary's own admission insert with nothing; anything else throws. */
const stubDatabase = (): Database =>
  ({
    log: { record: () => undefined, statements: () => [] },
    withBusiness: async (businessId: string, run: (tx: unknown) => Promise<unknown>) =>
      await run({
        businessId,
        query: async (text: string) => {
          if (!text.trimStart().startsWith('insert into public.authentication_attempts')) {
            throw new Error('the stub database has no rows');
          }
          return [];
        },
      }),
    close: async () => undefined,
  }) as unknown as Database;

const api = createApi({
  database: stubDatabase(),
  verify: createSupabaseVerifier({ secret: SECRET }),
  resolveBusiness: async (key) => (key === 'alpha' ? ALPHA : undefined),
  executeCommand,
});

async function raw(
  business: string,
  body: string,
  token?: string,
): Promise<readonly [number, string]> {
  const response = await api.fetch(
    new Request(`http://api.test/api/b/${business}/task/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body,
    }),
  );
  return [response.status, await response.text()];
}

describe('the boundary’s own refusals, as the HTTP response carries them', () => {
  const create = '{"operationId":"33333333-3333-4333-8333-333333333333","fields":{"title":"x"}}';

  it('answers an unsigned request, a non-object body and an unknown business the same way', async () => {
    const token = await sign(
      {
        sub: MIA,
        aud: 'authenticated',
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      SECRET,
      'HS256',
    );
    expect(await raw('alpha', create)).toStrictEqual([
      401,
      '{"refused":true,"code":"AUTH_UNKNOWN_LOGIN","names":[],"fixes":["Sign in. This endpoint reads the caller from verified authentication only."]}',
    ]);
    expect(await raw('alpha', '"not an object"', token)).toStrictEqual([
      400,
      '{"refused":true,"code":"COMMAND_BODY_INVALID","names":[],"fixes":["Send a JSON object holding the command’s own fields."]}',
    ]);
    expect(await raw('bravo', create, token)).toStrictEqual([
      403,
      '{"refused":true,"code":"AUTH_NO_MEMBERSHIP","names":[],"fixes":["ask an administrator of this business to link this login to a person","check that the business named in the request is the intended one"]}',
    ]);
  });
});
