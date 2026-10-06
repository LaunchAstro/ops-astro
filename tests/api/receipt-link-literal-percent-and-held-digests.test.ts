// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: a credential-free receipt path with an escaped literal percent is
// kept; a held credential is checked against its row's stored digest; and the
// child fixture beside it authenticates with the credential it is said to hold.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  configuredCredentialKeys,
  digestOf,
  issueAgentCredential,
  resolveDelegation,
  withCredentialKeys,
} from '../../packages/core-records/src/index.ts';
import { credentialKeyring } from '../../packages/core-records/src/authority/credential-keys.ts';
import { agentCredentials, receiptLinkOf } from '../../packages/core-runtime/src/receipt-link.ts';
import { HOST, launched, r, useReceiptWorld } from './aw-08-receipt-world.ts';

useReceiptWorld('rcptdigest');

it('a credential-free receipt path containing an escaped literal percent is kept', () => {
  const link = `https://${HOST}/effects/50%25-paid`;
  expect(new URL(link).href).toBe(link);
  expect(receiptLinkOf(link, 'synthetic_comment')).toBe(link);
});

async function parentRow(credential: string): Promise<string> {
  const rows = await r.fixture.db.admin.execute<{ id: string }>(
    'select id from public.delegations where business_id = $1 and credential_hash = $2',
    [r.fixture.business, digestOf(credential)],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the fixture parent is absent');
  return id;
}

it('credential derivation with mismatched key bytes fails closed against the stored digest', async () => {
  const { credential } = await launched();
  const id = await parentRow(credential);
  const configured = configuredCredentialKeys();
  if (!configured.ok) throw new Error('the fixture keyring is absent');
  const readHeld = async () =>
    await r.fixture.db.app.withBusiness(
      r.fixture.business,
      async (tx) => await agentCredentials(tx, id),
    );
  expect((await readHeld())?.includes(credential)).toBe(true);
  const keyId = configured.keys.activeKeyId;
  const wrong = credentialKeyring(keyId, new Map([[keyId, Buffer.alloc(32, 0x5a)]]));
  const held = await withCredentialKeys({ ok: true, keys: wrong }, readHeld);
  expect(held?.includes(credential) === true).toBe(false);
  expect(held === undefined, 'a digest mismatch must make the credential set uncheckable').toBe(
    true,
  );
});

it('the committed child fixture authenticates with the child credential its test claims is live', async () => {
  const { credential } = await launched();
  const parentId = await parentRow(credential);
  const configured = configuredCredentialKeys();
  if (!configured.ok) throw new Error('the fixture keyring is absent');
  const helper = await r.fixture.db.app.withBusiness(
    r.fixture.business,
    async (tx) =>
      await issueAgentCredential(tx, configured.keys, {
        personId: r.fixture.member.personId,
        actorId: r.fixture.member.actorId,
        purpose: `sol_${randomUUID().slice(0, 8)}`,
        scope: [{ collection: 'task', action: 'read' }],
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
  );
  const source = readFileSync(
    new URL('./receipt-link-keeps-no-respelled-credential.test.ts', import.meta.url),
    'utf8',
  );
  const sql = /`(insert into public\.delegations[\s\S]*?)`,/u.exec(source)?.[1];
  if (sql === undefined) throw new Error('the committed child fixture SQL is absent');
  const childId = randomUUID();
  const child = configured.keys.derive(configured.keys.activeKeyId, {
    businessId: r.fixture.business,
    agentActorId: helper.agentActorId,
    delegationId: childId,
  });
  if (child === undefined) throw new Error('the fixture child cannot be derived');
  await r.fixture.db.admin.execute(sql, [
    parentId,
    childId,
    helper.agentActorId,
    null,
    digestOf(child),
  ]);
  const resolved = await r.fixture.db.app.withBusiness(
    r.fixture.business,
    async (tx) => await resolveDelegation(tx, helper.agentActorId, child),
  );
  expect(resolved.ok, 'the tested child credential must identify the inserted child row').toBe(
    true,
  );
});
