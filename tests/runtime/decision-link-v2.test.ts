// SPDX-License-Identifier: AGPL-3.0-only
//
// The decision link's versions and the verifier's key resolver, with no
// database: what each link version covers, how a stored payload says which
// version it is, and how a chain signed under two key ids verifies.

import { describe, expect, it } from 'vitest';
import {
  CHAIN_GENESIS,
  chainHash,
  decisionLink,
  digestOf,
  keyResolver,
  linkVersionOf,
  sign,
  verifyChain,
  type DecisionLinkFields,
  type SigningKey,
} from '../../packages/core-runtime/src/signing.ts';

const FIELDS: DecisionLinkFields = {
  id: '00000000-0000-4000-8000-000000000001',
  seq: 1,
  gate: '00000000-0000-4000-8000-000000000002',
  version: '00000000-0000-4000-8000-000000000003',
  decision: 'approve',
  person: '00000000-0000-4000-8000-000000000004',
  payloadDigest: 'a'.repeat(64),
  signature: 'b'.repeat(64),
  round: 1,
  decidedAt: '2026-09-23T07:30:00.123456Z',
  lineage: '00000000-0000-4000-8000-000000000005',
  actor: '00000000-0000-4000-8000-000000000006',
  evidence: 'c'.repeat(64),
  key: 'test/link@1',
};

const ADDED_IN_V2: readonly [keyof DecisionLinkFields, unknown][] = [
  ['round', 2],
  ['decidedAt', '2026-09-23T07:30:00.123457Z'],
  ['lineage', '00000000-0000-4000-8000-000000000009'],
  ['actor', '00000000-0000-4000-8000-00000000000a'],
  ['evidence', 'd'.repeat(64)],
  ['key', 'test/link@2'],
];

describe('the decision link', () => {
  for (const [field, altered] of ADDED_IN_V2) {
    it(`v2 covers ${field}; v1 does not`, () => {
      const changed = { ...FIELDS, [field]: altered } as DecisionLinkFields;
      expect(chainHash(CHAIN_GENESIS, decisionLink(2, changed))).not.toBe(
        chainHash(CHAIN_GENESIS, decisionLink(2, FIELDS)),
      );
      expect(chainHash(CHAIN_GENESIS, decisionLink(1, changed))).toBe(
        chainHash(CHAIN_GENESIS, decisionLink(1, FIELDS)),
      );
    });
  }

  it('v1 is the link decide wrote before the change, field for field', () => {
    expect(decisionLink(1, FIELDS)).toStrictEqual({
      id: FIELDS.id,
      seq: FIELDS.seq,
      gate: FIELDS.gate,
      version: FIELDS.version,
      decision: FIELDS.decision,
      person: FIELDS.person,
      payloadDigest: FIELDS.payloadDigest,
      signature: FIELDS.signature,
    });
  });

  it('v2 names its version inside the hash, so a v2 link is never a v1 one', () => {
    expect(decisionLink(2, FIELDS)['link']).toBe(2);
  });

  it('reads the version from the signed payload: absent is v1, 2 is v2, anything else is unknown', () => {
    expect(linkVersionOf({ note: 'x' })).toBe(1);
    expect(linkVersionOf({ note: 'x', link: 2 })).toBe(2);
    expect(linkVersionOf({ note: 'x', link: 4 })).toBeUndefined();
    expect(linkVersionOf({ note: 'x', link: '2' })).toBeUndefined();
  });
});

describe('verifyChain with a key resolver', () => {
  const older: SigningKey = { id: 'test/older@0', secret: 'older secret' };
  const current: SigningKey = { id: 'test/current@1', secret: 'current secret' };

  function row(seq: number, previous: string, key: SigningKey) {
    const payload = { note: `decision ${seq}`, link: 2 };
    const payloadDigest = digestOf(payload);
    const signature = sign(key, payloadDigest);
    const fields = { ...FIELDS, seq, payloadDigest, signature, key: key.id };
    return {
      seq,
      prev_hash: previous,
      hash: chainHash(previous, decisionLink(2, fields)),
      payload,
      payload_digest: payloadDigest,
      signature,
      signing_key_id: key.id,
      fields,
    };
  }

  const first = row(1, CHAIN_GENESIS, older);
  const second = row(2, first.hash, current);
  const chain = [first, second];
  const link = (r: { readonly seq: number | bigint }) =>
    decisionLink(2, (chain[Number(r.seq) - 1] as typeof first).fields);

  it('verifies each row under its own key id when both are retained', () => {
    expect(verifyChain(keyResolver([current, older]), chain, link)).toBeNull();
  });

  it('fails closed on a key id the resolver does not know', () => {
    expect(verifyChain(keyResolver([current]), chain, link)).toBe(
      'seq 1: unknown signing key test/older@0',
    );
  });

  it('does not accept a retained key id presented with another key', () => {
    const impostor: SigningKey = { id: older.id, secret: 'not the older secret' };
    expect(verifyChain(keyResolver([current, impostor]), chain, link)).toBe(
      'seq 1: signature does not verify',
    );
  });

  it('still takes a single key, as a resolver of one', () => {
    expect(
      verifyChain(current, [row(1, CHAIN_GENESIS, current)], (r) =>
        decisionLink(2, { ...FIELDS, seq: Number(r.seq), ...signed(current) }),
      ),
    ).toBeNull();
  });
});

function signed(key: SigningKey) {
  const payloadDigest = digestOf({ note: 'decision 1', link: 2 });
  return { payloadDigest, signature: sign(key, payloadDigest), key: key.id };
}
