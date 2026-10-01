// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the command surface is served and what rides beside it: the prefixes
// the API mounts and the command line sends to, the person's own account paths,
// the public legal prefix, and the headers of an agent's delegation and a
// browser's session. Split from `surface.ts`, which re-exports each name.

/**
 * The two mounts the API serves the surface under and the command line sends
 * to, each followed by the business key and then `pathOf(name)`. One copy for
 * both sides. The agent's is its own so that an
 * agent asking and a person asking cannot be mistaken for each other.
 */
export const PREFIX = { person: '/api/b/', agent: '/api/a/b/' } as const;

/**
 * A person's own availability (MP-7-10), on the person prefix alone: their own
 * account, not a surface command, so no agent route and no grant row.
 */
export const ACCOUNT_AVAILABILITY_PATH = '/account/availability';

/**
 * C81: where a business's published legal documents are read with no sign-in,
 * as `${PUBLIC_PREFIX}<businessKey>/legal/<document>`. Nothing else is served
 * under it.
 */
export const PUBLIC_PREFIX = '/api/public/b/';

/**
 * The header an agent presents its delegation credential in.
 *
 * A header rather than a body field for the same reason the bearer token is
 * one: it is a credential, and a credential in a body is a credential that
 * gets logged with the payload, stored in the register row and compared by a
 * digest. The register compares what the request *is*; the authority it was
 * made under is not part of that.
 */
export const DELEGATION_HEADER = 'x-agent-delegation';

/**
 * The browser's session (S0-6c, `apps/api/auth/session.ts`): the route that
 * makes the cookie, the cookie prefix, the CSRF header and the tab's own session.
 */
export const SESSION_PATH = '/api/session';
export const SESSION_COOKIE = 'ops-astro-session';
export const CSRF_HEADER = 'x-ops-astro-csrf';
export const SESSION_HEADER = 'x-ops-astro-session';
