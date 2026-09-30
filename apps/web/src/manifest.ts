// SPDX-License-Identifier: AGPL-3.0-only
//
// THE ROUTE MANIFEST (MP-2-1, rulings R4 and R5): every address the product
// answers, in three namespaces. `agency` is the Hub, `clients` one client's
// workspace and `portal` that client's own view. The rail and the tab rows are
// read off it; a page whose ticket has not landed resolves to a placeholder
// naming that ticket. Hub pages match before client patterns, so
// `/clients/forms/` is the Hub's and `forms` is never a client.
//
// Legacy addresses are inputs, never outputs: `canonicalOf` is the one table
// from each mockup source address to its canonical one.

import { ROUTES, pathTo, type Namespace, type RouteId } from './routes.ts';

export interface Page {
  readonly namespace: Namespace;
  /** `<namespace>:<section>/<page>`: bare ids repeat across namespaces. */
  readonly id: string;
  readonly label: string;
  /** Canonical; `:client` marks the client's slug. */
  readonly path: string;
  /** The ticket that builds the page. */
  readonly ticket: string;
  /** The mockup source address it replaces, with the hash that chose it. */
  readonly legacy: string;
}

export interface Section {
  readonly namespace: Namespace;
  readonly id: string;
  readonly label: string;
  readonly path: string;
  /** The tab row. */
  readonly pages: Page[];
}

const ROOTS: Readonly<Record<Namespace, string>> = {
  agency: '/',
  clients: '/clients/:client/',
  portal: '/portal/:client/',
};

// The mockup's route table (`routes.json`, version 1). An unindented line opens
// a rail section, `namespace | label`; each page below it is `id | label |
// address under the namespace root | ticket | legacy source`. `@` reads a built
// page's address from `ROUTES`; `~` marks a page the rail and tabs leave out.
const TABLE = `
agency | Dashboard
  dashboard | Dashboard | dashboard/ | MP-2-10
  portfolio | Portfolio | dashboard/portfolio/ | MP-14-1 | /agency/portfolio/
  executive | Executive | dashboard/executive/ | MP-14-3 | /agency/executive/
agency | Inbox
  inbox | Inbox | inbox/ | MP-7-3
agency | Projects
  projects | Projects | @agency:projects-board | MP-5-8 | /agency/projects/
  reviews | Reviews | projects/reviews/ | MP-8-1
agency | Clients
  clients | Clients | clients/ | MP-8-5 | /agency/clients/
  forms | Forms | clients/forms/ | MP-12-6
agency | Connections & signal
  connections | Connections & signal | connections/ | MP-14-7 | /agency/connections-and-signal/
  site-health | Site health | connections/site-health/ | MP-14-11 | /agency/site-health/
agency | Docs
  docs | Docs | docs/ | MP-2-10
  snippets | Snippets | docs/snippets/ | MP-2-10
agency | Settings
  general | General | @agency:settings | MP-2-11
  keys | Keys | settings/keys/ | MP-2-10
  access | Access | settings/access/ | MP-2-10
  emails | Emails | settings/emails/ | MP-2-10
  workflow-triggers | Workflow triggers | settings/workflow-triggers/ | MP-2-10
  telemetry | Telemetry | settings/telemetry/ | MP-2-10
  cal | Cal | settings/cal/ | MP-2-10
clients | Overview
  brief | Brief | | MP-10-2 | /agency/brief/
  weekly-report | Weekly report | reports/weekly/ | MP-10-9 | /client-portal/reports/weekly-report/
  monthly-report | Monthly report | reports/monthly/ | MP-10-10 | /client-portal/reports/monthly-report/
  track-record | Track record | reports/track-record/ | MP-10-11 | /client-portal/reports/track-record/
clients | Projects
  projects | All projects | projects/ | MP-5-13 | /client-portal/projects/
  roadmap | Growth roadmap | projects/roadmap/ | MP-11-6 | /client-portal/projects/#roadmap
  worklog | Work log | projects/work-log/ | MP-10-1 | /client-portal/projects/#worklog
  reviews | Reviews | projects/reviews/ | MP-11-7 | /client-portal/projects/#reviews
clients | Channel workbench
  connections | Connections | workbench/ | MP-13-5 | /client-portal/channel-workbench/#connections
  site | Traffic & landing | workbench/traffic-landing/ | MP-13-6 | /client-portal/channel-workbench/#site
  clarity | On-page behaviour | workbench/on-page-behaviour/ | MP-13-7 | /client-portal/channel-workbench/#clarity
  search | Search & SEO | workbench/search-seo/ | MP-13-8 | /client-portal/channel-workbench/#search
  intent | Search intent | workbench/search-intent/ | MP-13-9 | /client-portal/channel-workbench/#intent
  ads | Google Ads | workbench/google-ads/ | MP-13-11 | /client-portal/channel-workbench/#ads
  meta | Meta Ads | workbench/meta-ads/ | MP-13-12 | /client-portal/channel-workbench/#meta
  testing | Testing | workbench/testing/ | MP-13-15 | /client-portal/channel-workbench/#testing
  local | Local & reviews | workbench/local-reviews/ | MP-13-15 | /client-portal/channel-workbench/#local
  calls | Calls | workbench/calls/ | MP-13-15 | /client-portal/channel-workbench/#calls
  email | Email marketing | workbench/email-marketing/ | MP-13-13 | /client-portal/channel-workbench/#email
  funnel | Funnel | workbench/funnel/ | MP-13-15 | /client-portal/channel-workbench/#funnel
  revenue | Revenue | workbench/revenue/ | MP-13-15 | /client-portal/channel-workbench/#revenue
  perf | Website performance | workbench/website-performance/ | MP-13-14 | /client-portal/channel-workbench/#perf
clients | Library
  brand | Brand | library/brand/ | MP-12-1 | /client-portal/library/brand/
  design-system | Design system | library/design-system/ | MP-12-2 | /client-portal/library/design-system/
  voice | Voice | library/voice/ | MP-12-3 | /client-portal/library/voice/
  drive | Drive | library/drive/ | MP-12-4 | /client-portal/library/drive/
clients | Docs
  docs | Docs | docs/ | MP-12-5
  shared | Shared with client | docs/shared/ | MP-12-5
  favourites | Favourites | docs/favourites/ | MP-12-5
  trash | Trash | docs/trash/ | MP-12-5
clients | Forms
  forms | Forms | forms/ | MP-12-6
  submissions | Submissions | forms/submissions/ | MP-12-6
  content | Content editor | forms/content-editor/ | MP-12-6
  preview | Preview & embed | forms/preview-embed/ | MP-12-6
clients | Account
  invoices | Invoices | account/ | MP-12-7 | /client-portal/account/#invoices
  adhoc | Ad hoc hours | account/ad-hoc-hours/ | MP-12-7 | /client-portal/account/#adhoc
  details | Business details | account/business-details/ | MP-12-8 | /client-portal/account/#details
  plan | Your plan | account/plan/ | MP-12-8 | /client-portal/account/#plan
  settings | Settings | account/settings/ | MP-12-8 | /client-portal/account/#settings
  ~activation-map | Activation map | activation-map/ | MP-14-13 | /agency/activation-map/
portal | Home
  home | Home | | MP-11-2 | /client-portal/home/
portal | Reports
  weekly-report | Weekly report | reports/weekly/ | MP-11-3
  monthly-report | Monthly report | reports/monthly/ | MP-11-3
  track-record | Track record | reports/track-record/ | MP-10-11
portal | Projects
  projects | All projects | projects/ | MP-11-4
  roadmap | Growth roadmap | projects/roadmap/ | MP-11-6
  reviews | Reviews | projects/reviews/ | MP-11-6
portal | Library
  brand | Brand | library/brand/ | MP-12-1
  voice | Voice | library/voice/ | MP-12-3
  drive | Drive | library/drive/ | MP-12-4
  docs | Docs | library/docs/ | MP-12-5 | /client-portal/library/docs/
portal | Account
  invoices | Invoices | account/ | MP-12-7
  adhoc | Ad hoc hours | account/ad-hoc-hours/ | MP-12-7
  details | Business details | account/business-details/ | MP-12-8
  plan | Your plan | account/plan/ | MP-12-8
  connect | Connections | account/connections/ | MP-11-8 | /client-portal/connections/
  settings | Settings | account/settings/ | MP-12-8
portal | Contact
  contact | Contact | contact/ | MP-11-9 | /client-portal/contact/
  ~book | Book a meeting | contact/book/ | MP-10-3 | /client-portal/contact/book/
`;

const drafts: { -readonly [Key in keyof Section]: Section[Key] }[] = [];
const parsed: Page[] = [];
for (const line of TABLE.split('\n').filter((each) => each.trim() !== '')) {
  const [key = '', label = '', below = '', ticket = '', legacy = ''] = line
    .split('|')
    .map((cell) => cell.trim());
  const open = drafts.at(-1);
  if (!line.startsWith(' ') || open === undefined) {
    const namespace = key as Namespace;
    drafts.push({ namespace, id: '', label, path: ROOTS[namespace], pages: [] });
    continue;
  }
  const id = key.replace(/^~/u, '');
  const path = below.startsWith('@')
    ? ROUTES[below.slice(1) as RouteId].path
    : `${ROOTS[open.namespace]}${below}`;
  if (open.pages.length === 0) [open.id, open.path] = [id, path];
  const section = key.startsWith('~') ? 'utility' : open.id;
  const page = {
    namespace: open.namespace,
    id: `${open.namespace}:${section}/${id}`,
    label,
    path,
    ticket,
    legacy,
  };
  parsed.push(page);
  if (section !== 'utility') open.pages.push(page);
}

/** The rail, in order, per namespace. */
export const SECTIONS: readonly Section[] = drafts;
/** Every address, the utility ones included. */
export const PAGES: readonly Page[] = parsed;

/** Every link from one face to another: `[from, to, address, reason]` (R5). */
export const CROSS_FACE: readonly (readonly [Namespace, Namespace, string, string])[] = [
  ['clients', 'agency', '/clients/', 'Back to Clients returns to the client list (SH-30).'],
  ['agency', 'clients', '/clients/:client/', 'The client list opens a workspace (R5).'],
  [
    'clients',
    'portal',
    '/portal/:client/',
    'What the client was sent, or the Client face (R5, R17).',
  ],
];

/** Whether the person may open this client's addresses in this business. */
export type ClientAccess = (businessKey: string, client: string) => boolean;
/** No client records exist before MP-10-1, so nobody holds a grant on one. */
export const NO_CLIENT_GRANTS: ClientAccess = () => false;

export interface PageMatch {
  readonly page: Page;
  readonly client: string | null;
}

const segments = (path: string): string[] =>
  path.split(/[?#]/u)[0]?.split('/').filter(Boolean) ?? [];

/** The client the pattern binds, null for none, false for no match. */
function fits(pattern: string, address: string): string | null | false {
  const want = segments(pattern);
  const have = segments(address);
  if (want.length !== have.length) return false;
  let client: string | null = null;
  for (const [index, part] of want.entries()) {
    const given = have[index] ?? '';
    if (part === ':client') client = given;
    else if (part !== given) return false;
  }
  return client;
}

const LITERAL_FIRST = PAGES.toSorted(
  (a, b) => Number(a.path.includes(':')) - Number(b.path.includes(':')),
);

export function pageAt(address: string): PageMatch | null {
  for (const page of LITERAL_FIRST) {
    const client = fits(page.path, address);
    if (client !== false) return { page, client };
  }
  return null;
}

export const fill = (path: string, client: string | null): string =>
  client === null ? path : path.replace(':client', client);

/** An address outside the manifest belongs to the face its prefix names. */
export function namespaceOf(address: string): Namespace {
  const [first, second] = segments(address);
  const named = pageAt(address)?.page.namespace;
  if (named !== undefined) return named;
  if (first === 'portal' && second !== undefined) return 'portal';
  return first === 'clients' && second !== undefined ? 'clients' : 'agency';
}

export const crossingDeclared = (from: Namespace, href: string): boolean =>
  namespaceOf(href) === from ||
  CROSS_FACE.some(
    ([at, to, path]) => at === from && to === namespaceOf(href) && fits(path, href) !== false,
  );

/** A mockup source address: never drawn, linked or stored. */
export const isLegacy = (address: string): boolean =>
  /^\/(?:agency|client-portal)\//u.test(address);

/**
 * The canonical address for a known legacy one, else null: the hash picks the
 * tab, `?client=` the client (none goes to the client list), and the canonical
 * address then passes the same grant check as any other.
 */
export function canonicalOf(address: string): string | null {
  const url = new URL(address, 'http://address.invalid');
  const path = url.pathname.replace(/\/?$/u, '/');
  const client = url.searchParams.get('client');
  const task = url.searchParams.get('task');
  if (path === '/agency/task/')
    return task === null ? null : pathTo('agency:task-detail', { key: task });
  const sources = PAGES.filter((page) => page.legacy !== '' && page.legacy.split('#')[0] === path);
  const chosen =
    sources.find((page) => url.hash !== '' && page.legacy.endsWith(url.hash)) ??
    sources.find((page) => !page.legacy.includes('#')) ??
    sources[0];
  if (chosen === undefined) return null;
  if (!chosen.path.includes(':client')) return chosen.path;
  return client === null ? '/clients/' : fill(chosen.path, encodeURIComponent(client));
}
