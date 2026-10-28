// SPDX-License-Identifier: AGPL-3.0-only
//
// #2316: `client.bind_site` binds a client's site and pages (`bindPartySite`),
// a person's act under `operations:manage` on the named client, never an
// agent's. A holder over one client binds that client and is refused another
// of the same business; another business's client answers as a made-up one;
// a member without the key, a client's person and a delegated agent are
// refused. Each refusal writes no site row and names no other client's or
// business's id. The world is C60's (`c60-client-privacy-world.ts`): Ada
// holds every declared key, Mia the task keys, Noah nothing, Tia nothing until
// given; Bea is bravo's. Every name, address and repository is made up.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl, type Answer } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import {
  appliedDetail,
  as,
  clientToken,
  createClient,
  credential,
  give,
  harness,
  member,
  newClient,
  outcome,
  tia,
  tiaToken,
  useClientsWorld,
} from '../authority/c60-client-privacy-world.ts';

useClientsWorld();

const MADE_UP = '00000000-0000-4000-8000-000000002316';
const REFUSED = { status: 403, code: 'SCOPE_NOT_GRANTED' };

/** A site of its own each time: repository, project and page drawn from a fresh tag. */
const siteBody = (tag: string = randomUUID().slice(0, 8)): Readonly<Record<string, unknown>> => ({
  repository: `client-sites/site-${tag}`,
  defaultBranch: 'main',
  project: `prj_${tag}`,
  pages: [{ pageUrl: `https://site-${tag}.example/about`, path: 'src/pages/about.astro' }],
});

const bindSite = async (
  clientId: string,
  site: Readonly<Record<string, unknown>> = siteBody(),
  token: string = harness.world.ada.token,
  key = 'alpha',
): Promise<Answer> =>
  await as('/client/bind_site', { operationId: randomUUID(), clientId, ...site }, token, key);

/** Every site and page row of a business, as the application reads them. */
const sitesOf = async (business: string): Promise<readonly string[]> =>
  (
    await harness.world.db.app.withBusiness(
      business,
      async (tx) =>
        await tx.query<{ readonly row: string }>(
          `select concat_ws(' ', party_id, repository, default_branch, project) as row
             from public.party_sites
           union all
           select concat_ws(' ', party_id, page_url, path) from public.party_site_pages
           order by 1`,
        ),
    )
  ).map((found) => found.row);

/** Tia given `operations:manage` over one client of alpha's, by Ada on Settings ▸ Access. */
const tiaOperates = async (clientId: string): Promise<void> => {
  const given = await give({
    holderId: tia.personId,
    collection: 'operations',
    action: 'manage',
    clientId,
  });
  appliedDetail(given, 'operations:manage over one client');
};

async function bindsAndBindsAgain(): Promise<void> {
  const clientId = await newClient('Bound Clinic');
  const tag = randomUUID().slice(0, 8);
  const site = siteBody(tag);
  expect(appliedDetail(await bindSite(clientId, site), 'the bind')).toEqual({ clientId });
  const bound = [
    `${clientId} client-sites/site-${tag} main prj_${tag}`,
    `${clientId} https://site-${tag}.example/about src/pages/about.astro`,
  ].toSorted();
  expect((await sitesOf(harness.world.alpha)).filter((row) => row.includes(tag))).toEqual(bound);
  // The same site again changes nothing.
  appliedDetail(await bindSite(clientId, site), 'the same bind again');
  expect((await sitesOf(harness.world.alpha)).filter((row) => row.includes(tag))).toEqual(bound);
}

async function peopleWithoutTheKeyAreRefused(): Promise<void> {
  const clientId = await newClient('Refused Clinic');
  const before = await sitesOf(harness.world.alpha);
  const people = [harness.world.mia.token, harness.world.noah.token, tiaToken, clientToken];
  for (const token of people) {
    // oxlint-disable-next-line no-await-in-loop
    expect(outcome(await bindSite(clientId, siteBody(), token))).toEqual(REFUSED);
  }
  // The agent acting for Ada, who holds the key, is refused it.
  const agent = await call(
    harness.world.api,
    agentPath('alpha', '/client/bind_site'),
    { operationId: randomUUID(), clientId, ...siteBody() },
    { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
  );
  expect(outcome(agent)).toEqual({ status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' });
  expect(await sitesOf(harness.world.alpha)).toEqual(before);
}

async function threeCrossings(): Promise<void> {
  const alphaOne = await newClient('Alpha One');
  const alphaTwo = await newClient('Alpha Two');
  const bravoClient = await createClient(
    `Bravo Only ${randomUUID().slice(0, 6)}`,
    harness.world.bea.token,
    'bravo',
  );
  await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
    await grantTo(tx, member(harness.world.bea), 'manage', WHOLE_BUSINESS, false, 'operations');
  });
  await tiaOperates(alphaOne);
  const alphaBefore = await sitesOf(harness.world.alpha);
  const bravoBefore = await sitesOf(harness.world.bravo);

  // Another client of the same business: Tia holds alphaOne alone.
  const otherClient = await bindSite(alphaTwo, siteBody(), tiaToken);
  expect(outcome(otherClient)).toEqual(REFUSED);
  expect(otherClient.text).not.toContain(alphaTwo);
  expect(otherClient.text).not.toContain(alphaOne);

  // Another business: its client answers as a made-up one, to each caller.
  const pair = async (foreign: string, token?: string, key?: string) => ({
    foreign: await bindSite(foreign, siteBody(), token, key),
    madeUp: await bindSite(MADE_UP, siteBody(), token, key),
  });
  const tiaAcross = await pair(bravoClient, tiaToken);
  const adaAcross = await pair(bravoClient);
  const beaAcross = await pair(alphaOne, harness.world.bea.token, 'bravo');
  for (const { foreign, madeUp } of [tiaAcross, adaAcross, beaAcross]) {
    expect(outcome(foreign)).toEqual(outcome(madeUp));
    expect(foreign.text).toBe(madeUp.text);
  }
  expect(outcome(adaAcross.foreign)).toEqual({ status: 404, code: 'NOT_FOUND' });
  expect(outcome(beaAcross.foreign)).toEqual({ status: 404, code: 'NOT_FOUND' });
  // Another person: Bea on alpha's prefix is no member of alpha.
  expect(outcome(await bindSite(alphaOne, siteBody(), harness.world.bea.token))).toEqual({
    status: 403,
    code: 'AUTH_NO_MEMBERSHIP',
  });
  expect(await sitesOf(harness.world.alpha)).toEqual(alphaBefore);
  expect(await sitesOf(harness.world.bravo)).toEqual(bravoBefore);

  // Tia's own client binds; neither business's rows hold the other's.
  appliedDetail(await bindSite(alphaOne, siteBody(), tiaToken), 'Tia over her client');
  expect((await sitesOf(harness.world.bravo)).join('\n')).not.toContain(alphaOne);
  expect((await sitesOf(harness.world.alpha)).join('\n')).not.toContain(bravoClient);
}

async function aBoundSiteOrPageStaysItsOwners(): Promise<void> {
  const first = await newClient('First Holder');
  const second = await newClient('Second Holder');
  const bravoClient = await createClient(
    `Bravo Holder ${randomUUID().slice(0, 6)}`,
    harness.world.bea.token,
    'bravo',
  );
  await harness.world.db.app.withBusiness(harness.world.bravo, async (tx) => {
    await grantTo(tx, member(harness.world.bea), 'manage', WHOLE_BUSINESS, false, 'operations');
  });
  const tag = randomUUID().slice(0, 8);
  appliedDetail(
    await bindSite(bravoClient, siteBody(tag), harness.world.bea.token, 'bravo'),
    "bravo's bind",
  );
  const alphaBefore = await sitesOf(harness.world.alpha);
  // Bravo's repository, and its project, are bound once in the installation.
  const repository = await bindSite(first, {
    ...siteBody(),
    repository: `client-sites/site-${tag}`,
  });
  const project = await bindSite(first, { ...siteBody(), project: `prj_${tag}` });
  for (const answer of [repository, project]) {
    expect(outcome(answer)).toEqual({ status: 409, code: 'SITE_BOUND_ELSEWHERE' });
    expect(answer.text).not.toContain(bravoClient);
  }
  // A page of the first client's site is not the second's.
  const own = siteBody();
  appliedDetail(await bindSite(first, own), "the first client's bind");
  const page = await bindSite(second, { ...siteBody(), pages: own['pages'] });
  expect(outcome(page)).toEqual({ status: 409, code: 'PAGE_BOUND_ELSEWHERE' });
  expect(page.text).not.toContain(first);
  const after = await sitesOf(harness.world.alpha);
  expect(
    after.filter((row) => !alphaBefore.includes(row)).every((row) => row.startsWith(first)),
  ).toBe(true);
}

/** Each field the command takes, sent wrong, and the field the refusal names. */
const MALFORMED: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
  ['repository', { repository: 'no-owner' }],
  ['repository', { repository: 'owner/../name' }],
  ['repository', { repository: 'owner/name/extra' }],
  ['defaultBranch', { defaultBranch: '' }],
  ['defaultBranch', { defaultBranch: 'feature/one' }],
  ['project', { project: 'prj one' }],
  ['pages', { pages: [] }],
  ['pages', { pages: 'https://site.example/about' }],
  ['pages', { pages: [{ pageUrl: 'http://site.example/about', path: 'src/pages/about.astro' }] }],
  ['pages', { pages: [{ pageUrl: 'https://site.example/a#b', path: 'src/pages/about.astro' }] }],
  [
    'pages',
    { pages: [{ pageUrl: 'https://user:pw@example.com/a', path: 'src/pages/about.astro' }] },
  ],
  ['pages', { pages: [{ pageUrl: 'https://site.example/about', path: 'src/pages/../x.astro' }] }],
  ['pages', { pages: [{ pageUrl: 'https://site.example/about', path: '/etc/about.astro' }] }],
  ['pages', { pages: [{ pageUrl: 'https://site.example/about', path: 'src/pages/about.ts' }] }],
  [
    'pages',
    {
      pages: [
        { pageUrl: 'https://site.example/about', path: 'src/pages/about.astro' },
        { pageUrl: 'https://site.example/about', path: 'src/pages/other.astro' },
      ],
    },
  ],
  [
    'pages',
    {
      pages: [
        { pageUrl: 'https://site.example/about', path: 'src/pages/about.astro', extra: true },
      ],
    },
  ],
];

async function malformedFieldsAreRefused(): Promise<void> {
  const clientId = await newClient('Malformed Clinic');
  const before = await sitesOf(harness.world.alpha);
  for (const [field, wrong] of MALFORMED) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await bindSite(clientId, { ...siteBody(), ...wrong });
    expect(outcome(answer), JSON.stringify(wrong)).toEqual({
      status: 422,
      code: 'FIELD_VALUE_INVALID',
    });
    expect(answer.body['names'], JSON.stringify(wrong)).toEqual([field]);
  }
  expect(outcome(await bindSite('not-a-client', siteBody()))).toEqual({
    status: 422,
    code: 'FIELD_VALUE_INVALID',
  });
  expect(await sitesOf(harness.world.alpha)).toEqual(before);
}

describe.skipIf(serverUrl === undefined)('#2316 client.bind_site', () => {
  it(
    "#2316 bind: a holder of operations:manage binds a client's site and its pages; the same bind again changes nothing",
    bindsAndBindsAgain,
  );
  it(
    '#2316 refusal operations:manage: a task holder, a member with nothing, a teammate without the key, a client and a delegated agent are refused, with nothing written',
    peopleWithoutTheKeyAreRefused,
  );
  it(
    "#2316 isolation: another client of the same business is refused, another business's client answers as a made-up one, and another business's person is no member; nothing is written",
    threeCrossings,
  );
  it(
    "#2316 store: another business's repository or project, and another client's page, are refused as bound elsewhere, naming no other client",
    aBoundSiteOrPageStaysItsOwners,
  );
  it(
    '#2316 fields: each malformed field is refused naming that field, with nothing written',
    malformedFieldsAreRefused,
  );
});
