// SPDX-License-Identifier: AGPL-3.0-only
//
// The operator step that binds the business's own site (R6, #1688) to the
// business itself, no client: agencyastro.com's About page to Agency Astro
// (#1690). No command writes a site; this step does, as a person of the
// business holding `operations:manage` over all of it (the operator gate,
// operator.ts), under that grant held (`authorisedAct`), on the application's
// own connection: an owner's login, or one past row security, is refused, so
// the policies judge the write as they judge the product's.
//
// The site is fixed here, not typed in: its repository, branch, Vercel
// project, host, and each page with its source file. Every page address is
// checked spelt exactly before anything is asked (https, the site's host, in
// lower case, no port, query, fragment or trailing slash), since the capture
// fence and a request match the stored address byte for byte. A business's
// own site bound to other providers is refused, never moved. A second run
// writes nothing and prints the same revision.
//
// The capture pool (`CapturePool.agencyPages`, core-connectors
// capture/fence.ts) is not a database row: it is the site runner's own
// configuration, which nothing in the tree sets for production yet. The step
// prints its exact entry, checked against the fence, for the runner's set-up.

import { checkPageAllowed } from '../../packages/core-connectors/src/index.ts';
import { connect, type TransactionQuery } from '../../packages/core-records/src/index.ts';
import { bindPartySite } from '../../packages/core-records/src/site/party-sites.ts';
import { authorisedAct } from './authorised-act.ts';
import { recordDeployment, requireOperator, type Gate } from './operator.ts';

/** The business's own site as the step binds it. */
export interface OwnSite {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly project: string;
  readonly host: string;
  readonly pages: readonly { readonly pageUrl: string; readonly path: string }[];
}

/** agencyastro.com, Agency Astro's own site (#1686, research R2). */
export const AGENCY_ASTRO_SITE: OwnSite = {
  repository: 'launchastro/agency-astro-astro',
  defaultBranch: 'main',
  project: 'prj_ZP8jeokQCN6SJsyuzkz4ISihdlHm',
  host: 'agencyastro.com',
  pages: [{ pageUrl: 'https://agencyastro.com/about', path: 'src/pages/about.astro' }],
};

export interface StepResult {
  readonly status: 0 | 1;
  readonly lines: readonly string[];
}

type Environment = Readonly<Record<string, string | undefined>>;

const NAME = 'bind-own-site';

/** Thrown inside the step's transaction, so a refusal there writes nothing. */
class Refusal extends Error {}

const refused = (why: string): StepResult => ({
  status: 1,
  lines: [`${NAME}: REFUSED: ${why}. Nothing was written.`],
});

/** The page address spelt exactly as the capture fence and a request match it, or why not. */
export function misspelt(pageUrl: string, host: string): string | undefined {
  const url = URL.canParse(pageUrl) ? new URL(pageUrl) : undefined;
  const plain =
    url !== undefined &&
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.hostname === host &&
    url.href === pageUrl &&
    pageUrl === pageUrl.toLowerCase() &&
    !/[?#]/u.test(pageUrl) &&
    !url.pathname.endsWith('/');
  return plain
    ? undefined
    : `the page address ${JSON.stringify(pageUrl)} is not spelt exactly: https on ${host}, ` +
        'lower case, no port, query, fragment or trailing slash';
}

/** What lets the connection past row security or makes it an owner's, or nothing. */
async function notApplication(tx: TransactionQuery): Promise<string | undefined> {
  const [row] = await tx.query<{ super: boolean; bypass: boolean; owner: boolean }>(
    `select r.rolsuper as super, r.rolbypassrls as bypass,
            pg_has_role(current_user, d.datdba, 'member') as owner
       from pg_roles r, pg_database d
      where r.rolname = current_user and d.datname = current_database()`,
  );
  if (row === undefined) return 'its role cannot be read';
  if (row.super) return 'is a superuser';
  if (row.bypass) return 'bypasses row security';
  return row.owner ? "is a member of the database's owner" : undefined;
}

const revisionOf = async (tx: TransactionQuery): Promise<number | undefined> => {
  const [row] = await tx.query<{ revision: number }>(
    `select revision from public.party_sites where business_id = $1 and party_id is null`,
    [tx.businessId],
  );
  return row?.revision;
};

/** The operator's own actor in the business, which the binding names as its writer. */
async function actorOf(tx: TransactionQuery, personId: string): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `select id::text from public.actors
      where business_id = $1 and person_id = $2 and kind = 'person' and active`,
    [tx.businessId, personId],
  );
  if (row === undefined) throw new Refusal('the operator has no active actor in the business');
  return row.id;
}

/** A business's own site already bound to other providers, which the step never moves. */
async function boundOtherwise(tx: TransactionQuery, site: OwnSite): Promise<boolean> {
  const [row] = await tx.query<{ other: boolean }>(
    `select (repository, default_branch, project) is distinct from ($2, $3, $4) as other
       from public.party_sites where business_id = $1 and party_id is null`,
    [tx.businessId, site.repository, site.defaultBranch, site.project],
  );
  return row?.other === true;
}

/** The binding, in one transaction as the operator: its revision, and whether it changed. */
async function bind(
  gate: Extract<Gate, { ok: true }>,
  url: string,
  site: OwnSite,
): Promise<{ revision: number; changed: boolean }> {
  const database = connect(url, { source: 'runtime' });
  try {
    return await database.withBusiness(gate.operator.businessId, async (tx) => {
      const why = await notApplication(tx);
      if (why !== undefined)
        throw new Refusal(`DATABASE_URL must be the application's login, and this one ${why}`);
      const actorId = await actorOf(tx, gate.operator.personId);
      if (await boundOtherwise(tx, site))
        throw new Refusal('the business already binds its own site to other providers');
      const before = await revisionOf(tx);
      const pages = await tx.query<{ n: number }>(
        'select count(*)::int as n from public.party_site_pages where business_id = $1',
        [tx.businessId],
      );
      const written = await bindPartySite(tx, { partyId: null, ...site }, actorId);
      if (!written.ok) throw new Refusal(`the store refused the binding: ${written.code}`);
      const after = await revisionOf(tx);
      const now = await tx.query<{ n: number }>(
        'select count(*)::int as n from public.party_site_pages where business_id = $1',
        [tx.businessId],
      );
      if (after === undefined) throw new Error(`${NAME}: the site is not bound after its write`);
      return { revision: after, changed: before !== after || pages[0]?.n !== now[0]?.n };
    });
  } finally {
    await database.close();
  }
}

/** The lines a done run prints: the binding, its stored revision and the capture pool's entries. */
function said(site: OwnSite, done: { revision: number; changed: boolean }): string[] {
  return [
    `${NAME}: bound ${site.repository}, branch ${site.defaultBranch}, Vercel project ` +
      `${site.project}, host ${site.host}, to the business itself (no client).`,
    ...site.pages.map((page) => `${NAME}: page ${page.pageUrl} maps to ${page.path}.`),
    `${NAME}: stored revision ${String(done.revision)} ` +
      `(${done.changed ? 'written' : 'unchanged: nothing written'}).`,
    ...site.pages.map(
      (page) =>
        `${NAME}: capture pool agencyPages entry ${JSON.stringify(page.pageUrl)} ` +
        "(configuration, not a database row: the site runner's CapturePool.agencyPages).",
    ),
  ];
}

/**
 * Bind `site` as the business's own, as the signed-in operator of the business
 * OPS_ASTRO_BUSINESS names. Never prints a credential or a database address.
 */
export async function runBindOwnSite(
  environment: Environment,
  site: OwnSite = AGENCY_ASTRO_SITE,
): Promise<StepResult> {
  // The capture pool the runner is to be given: exactly these pages, no other.
  const pool = {
    agencyPages: site.pages.map((page) => page.pageUrl),
    otherPages: [],
    closedPoolReviews: [],
  };
  for (const page of site.pages) {
    const why = misspelt(page.pageUrl, site.host);
    if (why !== undefined) return refused(why);
    if (!checkPageAllowed(page.pageUrl, pool).ok)
      return refused(`the capture fence would not admit ${page.pageUrl}`);
  }
  const gate = await requireOperator(environment);
  if (!gate.ok) return { status: 1, lines: [`${NAME}: REFUSED: ${gate.reason}`] };
  let done: { revision: number; changed: boolean };
  try {
    done = await authorisedAct(gate, async () => {
      const bound = await bind(gate, environment['DATABASE_URL'] ?? '', site);
      await recordDeployment(gate, {
        act: 'own-site.bind',
        repository: site.repository,
        branch: site.defaultBranch,
        project: site.project,
        host: site.host,
        page: site.pages[0]?.pageUrl,
        pages: site.pages,
        revision: bound.revision,
        changed: bound.changed,
      });
      return bound;
    });
  } catch (error) {
    if (error instanceof Refusal) return refused(error.message);
    if (/no longer holds/u.test((error as Error).message)) return refused((error as Error).message);
    throw error;
  }
  return { status: 0, lines: said(site, done) };
}
