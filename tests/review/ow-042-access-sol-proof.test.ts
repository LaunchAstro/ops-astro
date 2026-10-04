// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #413: Sol's OW-042 proof, unchanged
// (R/sol/proofs/OW-042-4126931d1.patch), and the same rule for a parent
// revoked rather than handed back: Access previews a child delegation only
// while its parent stands, as `checkDelegatedAuthority` admits it.
import { expect, it } from 'vitest';
import { readAccess } from '../../packages/core-commands/src/reads/people.ts';
import {
  checkDelegatedAuthority,
  revokeDelegation,
  settleDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { child, parentWork, useChildWorld, w } from '../runtime/aw-11-child-world.ts';

useChildWorld('sol042_aw');

it('Sol proof, criterion correctness: Access never previews usable child permissions after its parent delegation is settled', async () => {
  const { parent } = await parentWork(w.s);
  const minted = await child(w.s, parent, w.helper);
  const before = await w.s.db.app.withBusiness(w.s.business, async (tx) => await readAccess(tx));
  expect(
    before.agents.find((agent) => agent.delegationId === minted.delegation.id)?.permissions,
  ).toHaveLength(1);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => await settleDelegation(tx, parent.id));
  const admitted = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) =>
      await checkDelegatedAuthority(tx, minted.delegation, {
        collection: 'task',
        action: 'read',
        scope: parent.purposeScope,
      }),
  );
  expect(admitted).toMatchObject({ ok: false, refusal: { code: 'DELEGATION_REVOKED' } });
  const after = await w.s.db.app.withBusiness(w.s.business, async (tx) => await readAccess(tx));
  expect(
    after.agents.find((agent) => agent.delegationId === minted.delegation.id)?.permissions ?? [],
  ).toEqual([]);
});

it('Access never previews usable child permissions after its parent delegation is revoked', async () => {
  const { parent } = await parentWork(w.s);
  const minted = await child(w.s, parent, w.helper);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => await revokeDelegation(tx, parent.id));
  const admitted = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) =>
      await checkDelegatedAuthority(tx, minted.delegation, {
        collection: 'task',
        action: 'read',
        scope: parent.purposeScope,
      }),
  );
  expect(admitted).toMatchObject({ ok: false });
  const after = await w.s.db.app.withBusiness(w.s.business, async (tx) => await readAccess(tx));
  expect(
    after.agents.find((agent) => agent.delegationId === minted.delegation.id)?.permissions ?? [],
  ).toEqual([]);
});
