// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision reads the requester's run:write at the correction's client again
// after its locks: once the person who asked has lost it, the approval is
// refused and the correction stays requested. A decision also holds the page
// the correction names, and refuses one whose page the client's site no longer
// binds, as a correction it cannot see.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn("The requester's grant: DATABASE_URL is unset, so nothing ran.");

const WHOLE = { kind: 'business', id: null } as const;

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('requestergrant');
  expect(codeOf(await w.setApprover(w.ben.personId))).toBe('not-a-refusal');
}, 120_000);

function asked(result: CommandResult): { correctionId: string; versionId: string } {
  if (codeOf(result) !== 'not-a-refusal') throw new Error(`request refused ${codeOf(result)}`);
  const detail = (result as { readonly detail: Readonly<Record<string, unknown>> }).detail;
  return { correctionId: String(detail['correctionId']), versionId: String(detail['versionId']) };
}

/** A requester of their own, holding task read and run:write business-wide. */
async function requester(name: string) {
  const member = await enrol(w.world.db.app, w.world.business, name);
  const runWrite = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, member, 'read');
    return await grantTo(tx, member, 'write', WHOLE, false, 'run');
  });
  return { member, runWrite };
}

describe.skipIf(serverUrl === undefined)("an approval and the requester's grant", () => {
  it('approves while the requester still holds run:write at the client', async () => {
    const { member } = await requester('keeps');
    const { correctionId, versionId } = asked(await w.as(member, requestBody(w.partyA, w.taskA)));
    expect(codeOf(await w.approve(w.ben, correctionId, versionId))).toBe('not-a-refusal');
    expect(await w.stateOf(correctionId)).toBe('approved');
  });

  it('refuses the approval once the requester has lost run:write at the client', async () => {
    const { member, runWrite } = await requester('loses');
    const { correctionId, versionId } = asked(await w.as(member, requestBody(w.partyA, w.taskA)));
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await revokeGrant(tx, runWrite);
    });
    expect(codeOf(await w.approve(w.ben, correctionId, versionId))).toBe('REQUESTER_GRANT_ENDED');
    expect(await w.stateOf(correctionId)).toBe('requested');
  });
});

describe.skipIf(serverUrl === undefined)('an approval and the page it names', () => {
  it("refuses a correction whose page the client's site no longer binds", async () => {
    const { correctionId, versionId } = asked(await w.request(w.ava));
    // Past the freeze, as a row from before the store held its pages would be.
    await w.world.db.admin.execute(
      `begin;
       set local session_replication_role = replica;
       delete from public.party_site_pages p
        using public.live_corrections c
        where c.id = '${correctionId}' and p.business_id = c.business_id
          and p.party_id = c.party_id and p.page_url = c.page_url;
       commit;`,
    );
    expect(codeOf(await w.approve(w.ben, correctionId, versionId))).toBe('NOT_FOUND');
    expect(await w.stateOf(correctionId)).toBe('requested');
  });
});
