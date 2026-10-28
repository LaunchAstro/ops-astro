// SPDX-License-Identifier: AGPL-3.0-only
//
// `client.bind_site` (#2316): binds a client's site and its pages through the
// party-site store (`bindPartySite`), under `operations:manage` on the named
// client (party scope, `prepare.ts`), a person's act and never an agent's,
// audited by the envelope. A page already held stays bound; unbinding is not
// this command's.
//
// Every field is checked here as the site runner reads its configured site
// (`apps/site-runner/settings.ts`), so a binding the runner could never match
// is refused before anything is written. The client is read in this business
// first: another business's client answers as a made-up one. The store's own
// refusals come back by their codes and name only the field sent, never the
// holder: a repository or project is bound once in the installation.

import {
  bindPartySite,
  isClientHere,
  isUuid,
  type SiteWrite,
  type TenantQuery,
  type TransactionQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type Request = CommandRequest & { readonly command: 'client.bind_site' };

/** One plain name segment, as the guarded call and the runner accept it. */
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/u;
/** A page source under `src/pages/`: plain segments, an Astro or Markdown file. */
const SOURCE_SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;
const MOST_PAGES = 50;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  clientId: ['Name one client of this business by its identifier.'],
  repository: ['Send the repository as owner/name, each part letters, digits, ".", "_" or "-".'],
  defaultBranch: ['Send the default branch as one name: letters, digits, ".", "_" or "-".'],
  project: ['Send the hosting project id: letters, digits, ".", "_" or "-".'],
  pages: [
    `Send 1 to ${String(MOST_PAGES)} pages, each { pageUrl, path } and no other key, each address once.`,
    'pageUrl is an exact https address with no sign-in details or fragment.',
    'path is the page source under src/pages/, an .astro or .md file.',
  ],
};

const STORE_FIXES: Readonly<Record<Exclude<SiteWrite, { ok: true }>['code'], string>> = {
  SITE_BOUND_ELSEWHERE: 'This repository or hosting project is bound to another site already.',
  PAGE_BOUND_ELSEWHERE: 'One of these pages is bound to another site of this business already.',
  SITE_UNDER_CORRECTION: "An open correction holds this client's site; its providers stay.",
  PAGE_UNDER_CORRECTION: 'An open correction holds this page; it stays bound.',
};

const STORE_NAMES: Readonly<Record<Exclude<SiteWrite, { ok: true }>['code'], string[]>> = {
  SITE_BOUND_ELSEWHERE: ['repository', 'project'],
  PAGE_BOUND_ELSEWHERE: ['pages'],
  SITE_UNDER_CORRECTION: ['repository', 'defaultBranch', 'project'],
  PAGE_UNDER_CORRECTION: ['pages'],
};

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

const plain = (value: unknown): value is string =>
  typeof value === 'string' && SEGMENT.test(value) && value !== '.' && value !== '..';

const exactPage = (value: unknown): value is string => {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  return (
    url !== null &&
    url.protocol === 'https:' &&
    url.href === value &&
    url.username === '' &&
    url.password === '' &&
    !value.includes('#') &&
    value.length <= 2000
  );
};

const pageSource = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 500) return false;
  const [top, pages, ...rest] = value.split('/');
  return (
    top === 'src' &&
    pages === 'pages' &&
    rest.length > 0 &&
    rest.every((segment) => SOURCE_SEGMENT.test(segment)) &&
    /\.(?:astro|md)$/u.test(rest.at(-1) ?? '')
  );
};

/** The pages as sent, or undefined when any is not an exact page with its source file. */
function pagesOf(value: unknown): { pageUrl: string; path: string }[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MOST_PAGES) return undefined;
  const pages: { pageUrl: string; path: string }[] = [];
  for (const page of value as unknown[]) {
    if (typeof page !== 'object' || page === null || Array.isArray(page)) return undefined;
    const { pageUrl, path, ...rest } = page as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || !exactPage(pageUrl) || !pageSource(path)) return undefined;
    pages.push({ pageUrl, path });
  }
  const addresses = new Set(pages.map((page) => page.pageUrl));
  // In address order, so two binds naming the same pages take them in one order (S2333-2).
  return addresses.size === pages.length
    ? pages.toSorted((a, b) => (a.pageUrl < b.pageUrl ? -1 : 1))
    : undefined;
}

/** The handler's transaction is the store's: its savepoint keeps a refusal from failing it. */
function asTransaction(tx: TenantQuery): TransactionQuery {
  const held = tx as Partial<TransactionQuery>;
  if (typeof held.savepoint !== 'function') throw new Error('client.bind_site needs a savepoint');
  return tx as TransactionQuery;
}

export async function bindClientSite(
  tx: TenantQuery,
  context: CommandContext,
  request: Request,
): Promise<HandlerOutcome> {
  if (!isUuid(request.clientId)) return invalid('clientId');
  const { repository, defaultBranch, project } = request;
  const [owner, name, ...extra] = typeof repository === 'string' ? repository.split('/') : [];
  if (!plain(owner) || !plain(name) || extra.length > 0) return invalid('repository');
  if (!plain(defaultBranch)) return invalid('defaultBranch');
  if (!plain(project)) return invalid('project');
  const pages = pagesOf(request.pages);
  if (pages === undefined) return invalid('pages');
  const clientId = request.clientId.toLowerCase();
  if (!(await isClientHere(tx, clientId))) return refused(refuseNotFound());
  const written = await bindPartySite(
    asTransaction(tx),
    { partyId: clientId, repository: `${owner}/${name}`, defaultBranch, project, pages },
    context.session.actorId,
  );
  if (!written.ok) {
    const { code } = written;
    return refused(refuseCommand(code, STORE_NAMES[code], [STORE_FIXES[code]]));
  }
  return applied(clientId, null, { clientId });
}
