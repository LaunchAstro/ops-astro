// SPDX-License-Identifier: AGPL-3.0-only
//
// A sealed secret is bound to where it was set: its business, its name and
// its scope. Someone who can write the table but not open a value cannot
// move a sealed value onto another row, name, scope or business and have the
// broker open it there. A value sealed before the binding (only the key id
// authenticated) still opens: production holds such values until each is set
// again.

import {
  createCipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createClient } from '../../packages/core-records/src/clients/clients.ts';
import {
  generateSealingPair,
  open,
  seal,
  setSecret,
  type SecretScope,
} from '../../packages/core-records/src/custody/index.ts';
import type { Sealed, SealedAt } from '../../packages/core-records/src/custody/sealing.ts';

const pair = generateSealingPair('test/sealed-place@1');
const VALUE = `sealed-place-${randomUUID()}`;
const home: SealedAt = {
  businessId: randomUUID(),
  name: 'provider.key',
  scope: { kind: 'business', id: null },
};

/** The sealing formula before the binding: the key id is the only additional data. */
function sealedBeforeTheBinding(value: string): Sealed {
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = Buffer.from(
    String(ephemeral.publicKey.export({ format: 'jwk' }).x),
    'base64url',
  );
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: pair.key.publicKey });
  const salt = Buffer.concat([ephemeralPublic, Buffer.from(pair.key.keyId)]);
  const key = Buffer.from(hkdfSync('sha256', shared, salt, 'ops-astro custody v1', 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(pair.key.keyId));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { sealed: body, ephemeralPublic, nonce, keyId: pair.key.keyId };
}

describe('a sealed secret and the place it was set', () => {
  it('opens where it was sealed', () => {
    expect(open(seal(VALUE, pair.key, home), pair.privateKey, home)).toBe(VALUE);
  });

  it.each<[string, SealedAt]>([
    ['another business', { ...home, businessId: randomUUID() }],
    ['another name', { ...home, name: 'provider.other' }],
    ['a client scope', { ...home, scope: { kind: 'party', id: randomUUID() } }],
  ])('does not open when moved to %s', (_, elsewhere) => {
    const sealed = seal(VALUE, pair.key, home);
    expect(() => open(sealed, pair.privateKey, elsewhere)).toThrow();
  });

  it('does not open at one client when sealed for another', () => {
    const client: SealedAt = { ...home, scope: { kind: 'party', id: randomUUID() } };
    const sealed = seal(VALUE, pair.key, client);
    expect(open(sealed, pair.privateKey, client)).toBe(VALUE);
    expect(() =>
      open(sealed, pair.privateKey, { ...client, scope: { kind: 'party', id: randomUUID() } }),
    ).toThrow();
  });

  it('opens a value sealed before the binding nowhere, asking for it to be set again', () => {
    expect(() => open(sealedBeforeTheBinding(VALUE), pair.privateKey, home)).toThrow(
      /set it again/u,
    );
  });

  it('does not open a bound value passed off as one sealed before the binding', () => {
    const sealed = seal(VALUE, pair.key, home);
    expect(sealed.nonce).toHaveLength(13);
    const relabelled: Sealed = { ...sealed, nonce: sealed.nonce.subarray(1) };
    expect(() => open(relabelled, pair.privateKey, home)).toThrow();
  });
});

interface StoredRow {
  readonly id: string;
  readonly business_id: string;
  readonly name: string;
  readonly scope_kind: SecretScope['kind'];
  readonly scope_id: string | null;
  readonly sealed: Buffer;
  readonly ephemeral_public: Buffer;
  readonly nonce: Buffer;
  readonly key_id: string;
}

/** The broker's open of a stored row: the place it is bound to is the row's own. */
const openRow = (row: StoredRow): string =>
  open(
    {
      sealed: row.sealed,
      ephemeralPublic: row.ephemeral_public,
      nonce: row.nonce,
      keyId: row.key_id,
    },
    pair.privateKey,
    {
      businessId: row.business_id,
      name: row.name,
      scope: { kind: row.scope_kind, id: row.scope_id },
    },
  );

let controls: Controls;

const set = async (name: string, scope: SecretScope, value: string): Promise<string> => {
  const { db, business } = controls.fixture;
  const written = await db.app.withBusiness(
    business,
    async (tx) =>
      await setSecret(tx, { name, scope, value, key: pair.key, actorId: controls.manager.actorId }),
  );
  if (!('id' in written)) throw new Error('the secret was not set');
  return written.id;
};

const rowOf = async (id: string): Promise<StoredRow> => {
  const [row] = await controls.fixture.db.admin.execute<StoredRow>(
    `select id, business_id, name, scope_kind, scope_id, sealed, ephemeral_public, nonce, key_id
       from public.custody_secrets where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such secret');
  return row;
};

/** Copy one row's sealed columns over another's, as a writer of the table could. */
const copySealed = async (from: string, to: string): Promise<void> => {
  await controls.fixture.db.admin.execute(
    `update public.custody_secrets t
        set sealed = f.sealed, ephemeral_public = f.ephemeral_public, nonce = f.nonce,
            key_id = f.key_id
       from public.custody_secrets f
      where f.id = $1 and t.id = $2`,
    [from, to],
  );
};

describe.skipIf(databaseUrlFromEnvironment() === undefined)('a stored sealed secret', () => {
  beforeAll(async () => {
    controls = await createControls('sealedplace', { custody: pair.key });
  }, 120_000);

  afterAll(async () => {
    await controls?.drop();
  });

  it('opens on its own row and on no other row it is copied to', async () => {
    const { db, business } = controls.fixture;
    const client = await db.app.withBusiness(
      business,
      async (tx) => await createClient(tx, 'Sealed place client', controls.manager.actorId),
    );
    if (!client.ok) throw new Error('the client was not made');
    const source = await set('place.source', { kind: 'business', id: null }, VALUE);
    const renamed = await set('place.renamed', { kind: 'business', id: null }, 'other-value-1');
    // A client id in upper case binds the row it names, which the database prints in lower case.
    const party = { kind: 'party', id: client.value.toUpperCase() } as const;
    const scoped = await set('place.source', party, 'other-value-2');
    const original = await rowOf(source);
    expect(openRow(original)).toBe(VALUE);
    expect(openRow(await rowOf(scoped))).toBe('other-value-2');

    for (const target of [renamed, scoped]) {
      // eslint-disable-next-line no-await-in-loop -- one copy, then its open
      await copySealed(source, target);
      // eslint-disable-next-line no-await-in-loop -- the copy is in place
      const copied = await rowOf(target);
      expect(copied.sealed.equals(original.sealed)).toBe(true);
      expect(() => openRow(copied)).toThrow();
    }
  });
});
