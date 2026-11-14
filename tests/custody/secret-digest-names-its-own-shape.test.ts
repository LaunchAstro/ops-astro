// SPDX-License-Identifier: AGPL-3.0-only
//
// A sealed body's keyed digest can never equal the plain digest of some other
// body (#372, Sol S2413-1). The register keeps one digest per operation id and
// still accepts a plain one written before values were keyed, so a retry whose
// value is the keyed wrapper of the first value must not pass as the first
// request. The real `enter` and `register` run over an in-memory register:
// no database is needed to show which answer a retry gets.

import { describe, expect, it } from 'vitest';
import { enter, register } from '../../packages/core-commands/src/commands/envelope.ts';
import {
  comparablePayload,
  requestDigest,
} from '../../packages/core-commands/src/commands/payload.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';
import { payloadDigest } from '../../packages/core-digest/src/index.ts';
import {
  credentialKeyring,
  withCredentialKeys,
} from '../../packages/core-records/src/authority/credential-keys.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

const owner = {
  businessId: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
};
const ring = credentialKeyring('proof', new Map([['proof', Buffer.alloc(32, 1)]]));
const keys = { ok: true, keys: ring } as const;
const success = { command: 'secret.set', recordId: null, revision: 1, detail: {} };

interface Stored {
  readonly command: string;
  readonly payload_digest: string;
  readonly outcome: unknown;
  readonly result: unknown;
}

/** One register row and the audit lines, as the envelope's statements write them. */
function registerOf(planted?: Stored) {
  let seen = planted;
  const tx = {
    businessId: owner.businessId,
    query: async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes('select command, payload_digest')) return seen === undefined ? [] : [seen];
      if (sql.includes('insert into operations')) {
        seen = {
          command: String(params[3]),
          payload_digest: String(params[5]),
          outcome: params[6],
          result: params[7],
        };
        return [];
      }
      if (sql.includes('insert into audit_events'))
        return [{ id: 'audit', seq: '1', hash: '0'.repeat(64) }];
      return [];
    },
  } as unknown as TenantQuery;
  const entry = {
    release: async () => undefined,
    attempt: async (request: UncheckedRequest, digest: string) => {
      await register(tx, owner, request as never, digest, success as never, null);
      return success;
    },
  };
  const send = async (request: UncheckedRequest) =>
    (await withCredentialKeys(keys, () => enter(tx, owner, request, entry as never))) as {
      readonly code?: string;
    };
  return { send, stored: () => seen };
}

const first = {
  command: 'secret.set',
  operationId: 'secret-digest-shape',
  name: 'proof.key',
  value: 'pin-4821',
} as UncheckedRequest;

describe('a sealed body keyed digest names its own shape (S2413-1)', () => {
  it('a retry whose value is the keyed wrapper of the first value is refused, not replayed', async () => {
    const { send, stored } = registerOf();
    await send(first);
    expect(stored()?.payload_digest).toBe(requestDigest(owner, first, keys).digest);
    const valueMac = ring.valueMac(owner.businessId, owner.actorId, JSON.stringify('pin-4821'));
    const forged = { ...first, value: { valueMac } } as UncheckedRequest;
    expect((await send(forged)).code).toBe('OPERATION_ID_REUSED');
  });

  it('the same request sent again still replays the first answer', async () => {
    const { send } = registerOf();
    await send(first);
    expect((await send(first)).code).toBeUndefined();
  });

  it('a plain digest kept from before values were keyed still recognises its own retry', async () => {
    const plain = payloadDigest(comparablePayload(first));
    const { send } = registerOf({
      command: 'secret.set',
      payload_digest: plain,
      outcome: 'applied',
      result: success,
    });
    expect((await send(first)).code).toBeUndefined();
    const other = { ...first, value: 'pin-4822' } as UncheckedRequest;
    expect((await send(other)).code).toBe('OPERATION_ID_REUSED');
  });
});
