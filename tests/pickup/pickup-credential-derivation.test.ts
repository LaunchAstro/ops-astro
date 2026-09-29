// SPDX-License-Identifier: AGPL-3.0-only
//
// PICKUP-REPLAY proof group 5: the derivation is pinned, its encoding, what
// changes it and what does not. Group 4 (the keyring) and the legacy limit are
// in pickup-replay-keys.test.ts; this group needs no database.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  ACTIVE_KEY_VARIABLE,
  configuredCredentialKeys,
  credentialEncoding,
  credentialKeyring,
  ensureCredentialKeyFile,
  KEYRING_VARIABLE,
  parseCredentialKeys,
  type CredentialIdentity,
} from '../../packages/core-records/src/authority/credential-keys.ts';

const key = (): string => randomBytes(32).toString('base64url');
const identity: CredentialIdentity = {
  businessId: '11111111-1111-4111-8111-111111111111',
  agentActorId: '22222222-2222-4222-8222-222222222222',
  delegationId: '33333333-3333-4333-8333-333333333333',
};

describe('the credential derivation (group 5)', () => {
  it('is HMAC-SHA256 over the fixed, versioned JSON encoding', async () => {
    expect(credentialEncoding('k@1', identity)).toBe(
      '["ops-astro/delegation-credential/v1","k@1",' +
        '"11111111-1111-4111-8111-111111111111",' +
        '"22222222-2222-4222-8222-222222222222",' +
        '"33333333-3333-4333-8333-333333333333"]',
    );
    const bytes = Buffer.from(key(), 'base64url');
    const ring = credentialKeyring('k@1', new Map([['k@1', bytes]]));
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', bytes)
      .update(credentialEncoding('k@1', identity))
      .digest('base64url');
    expect(ring.derive('k@1', identity)).toBe(expected);
    expect(Buffer.from(expected, 'base64url')).toHaveLength(32);
    expect(ring.derive('k@2', identity)).toBeUndefined();
  });

  it('changes with the key, key id, business, agent and delegation, and nothing else', () => {
    const a = key();
    const ring = parseCredentialKeys('a', `a:${a},b:${a}`);
    const other = parseCredentialKeys('a', `a:${key()}`);
    if (!ring.ok || !other.ok) throw new Error('keyring');
    const base = ring.keys.derive('a', identity);
    expect(ring.keys.derive('a', { ...identity })).toBe(base);
    const variants = [
      other.keys.derive('a', identity),
      ring.keys.derive('b', identity),
      ring.keys.derive('a', { ...identity, businessId: randomUUID() }),
      ring.keys.derive('a', { ...identity, agentActorId: randomUUID() }),
      ring.keys.derive('a', { ...identity, delegationId: randomUUID() }),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('refuses a malformed keyring rather than repairing it', () => {
    const good = key();
    const cases: readonly [string | undefined, string | undefined][] = [
      [undefined, `a:${good}`],
      ['a', undefined],
      ['a', `a:${randomBytes(16).toString('base64url')}`],
      ['a', `a:${good}=`],
      ['a', `a:${good},a:${key()}`],
      ['b', `a:${good}`],
      ['a', good],
    ];
    for (const [active, ring] of cases) {
      const decision = parseCredentialKeys(active, ring);
      expect(decision.ok, `${String(active)} ${String(ring)}`).toBe(false);
      if (!decision.ok) expect(decision.problem).not.toContain(good);
    }
    // Half an explicit configuration is a fault, not a fallback to the file.
    expect(configuredCredentialKeys({ [ACTIVE_KEY_VARIABLE]: 'a' }).ok).toBe(false);
  });

  it('provisions a key file once, 0600, and never rewrites it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pickup-replay-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'delegation.env');
    const first = ensureCredentialKeyFile(file);
    const text = readFileSync(file, 'utf8');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = ensureCredentialKeyFile(file);
    expect(readFileSync(file, 'utf8')).toBe(text);
    if (!first.ok || !second.ok) throw new Error('provisioning');
    expect(second.keys.activeKeyId).toBe(first.keys.activeKeyId);
    expect(second.keys.derive(second.keys.activeKeyId, identity)).toBe(
      first.keys.derive(first.keys.activeKeyId, identity),
    );

    // Malformed is refused and left exactly as it is.
    writeFileSync(file, `${ACTIVE_KEY_VARIABLE}=a\n${KEYRING_VARIABLE}=a:short\n`);
    const broken = ensureCredentialKeyFile(file);
    expect(broken.ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(
      `${ACTIVE_KEY_VARIABLE}=a\n${KEYRING_VARIABLE}=a:short\n`,
    );
  });
});
