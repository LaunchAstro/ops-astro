// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the surface is served: the two command mounts, the person's own
// account path, the public legal prefix and the header an agent presents its
// delegation in. Split from `surface.ts`, which re-exports them, to keep that
// file under the line limit.

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
