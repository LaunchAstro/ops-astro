// SPDX-License-Identifier: AGPL-3.0-only
//
// The agency About binding step (scripts/ops/bind-own-site.ts) runs only as a
// person of the business holding `operations:manage` over all of it, through
// the application's own connection, never an owner's: a person without the
// grant, another business's operator, and an owner connection are refused,
// with nothing written. Another business cannot see the binding: its own
// operator, binding the same site in their own business, is refused and reads
// none of it.

import { describe, expect, it } from 'vitest';
import { readPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import { runBindOwnSite } from '../../scripts/ops/bind-own-site.ts';
import {
  allSites,
  ownSiteHooks,
  ownSiteOf,
  recordsIn,
  serverUrl,
  signedIn,
  subjects,
  type OwnSiteWorld,
} from './own-site-bind-step.fixture.ts';

let w: OwnSiteWorld;
ownSiteHooks((world) => {
  w = world;
});

/** Refused, with no site, page or record written anywhere. */
const refusedUnwritten = async (env: Record<string, string>, reason: RegExp) => {
  const before = await allSites(w);
  const records = recordsIn(w).length;
  const ran = await runBindOwnSite(env);
  expect(ran.status, ran.lines.join('\n')).toBe(1);
  expect(ran.lines.join('\n')).toMatch(reason);
  expect(await allSites(w)).toEqual(before);
  expect(recordsIn(w)).toHaveLength(records);
};

describe.skipIf(serverUrl === undefined)('who may run the agency About binding step', () => {
  it('refuses a person of the business without operations:manage', async () => {
    await refusedUnwritten(
      await signedIn(w, subjects.keyless, 'agency'),
      /REFUSED: .*not a person of agency holding operations:manage/u,
    );
    expect((await ownSiteOf(w, w.agency)).site).toBeUndefined();
  });

  it("refuses the operator's own sign-in over an owner connection", async () => {
    const env = await signedIn(w, subjects.operator, 'agency', { DATABASE_URL: w.adminUrl });
    await refusedUnwritten(env, /REFUSED: DATABASE_URL .*(superuser|row security|owner)/u);
    expect((await ownSiteOf(w, w.agency)).site).toBeUndefined();
  });

  it("refuses another business's operator acting in this business", async () => {
    await refusedUnwritten(
      await signedIn(w, subjects.otherOperator, 'agency'),
      /REFUSED: .*not a person of agency/u,
    );
    expect((await ownSiteOf(w, w.agency)).site).toBeUndefined();
  });
});

describe.skipIf(serverUrl === undefined)('the agency About binding, from another business', () => {
  it('keeps the binding from another business binding the same site in its own business', async () => {
    // Positive control: the agency's operator binds it.
    const ours = await runBindOwnSite(await signedIn(w, subjects.operator, 'agency'));
    expect(ours.status, ours.lines.join('\n')).toBe(0);
    const env = await signedIn(w, subjects.otherOperator, 'other');
    const before = await allSites(w);
    const theirs = await runBindOwnSite(env);
    expect(theirs.status).toBe(1);
    expect(theirs.lines.join('\n')).toMatch(/REFUSED: .*SITE_BOUND_ELSEWHERE/u);
    expect(theirs.lines.join('\n')).not.toContain(w.agency);
    expect(await allSites(w)).toEqual(before);
    // What the other business reads of its own tenancy: nothing of the agency's.
    const seen = await w.db.app.withBusiness(w.other, async (tx) => ({
      own: await readPartySite(tx, null),
      sites: await tx.query('select 1 from public.party_sites'),
      pages: await tx.query('select 1 from public.party_site_pages'),
    }));
    expect(seen).toEqual({ own: undefined, sites: [], pages: [] });
    expect((await ownSiteOf(w, w.agency)).pages).toHaveLength(1);
  });
});
