// SPDX-License-Identifier: AGPL-3.0-only
//
// `POST /api/enrol` (C39-T, piece P3): the enrolment page's token and password,
// and the invitation accepted (`acceptInvitation`), outside the business
// prefix: no sign-in, grant or cookie; the token, in the body, is the
// authority. The answer is a code (API.md), no session; nothing is logged.

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { acceptInvitation } from '../../packages/core-commands/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import { ENROL_PATH } from '../../packages/core-wire/src/index.ts';

/** A token and a password, and room for their JSON, no more. */
const ENROL_MAX_BYTES = 2048;

export interface EnrolmentOptions {
  /** The deployment's businesses, the ones a token is looked for in. */
  readonly businesses: () => Promise<readonly BusinessId[]>;
  /** The broker the login provider is reached through. */
  readonly broker: Broker;
}

const STATUS = {
  ENROLMENT_LINK_INVALID: 404,
  PASSWORD_INVALID: 400,
  ENROLMENT_UNAVAILABLE: 503,
} as const;

/** The body's token and password, when it is one JSON object holding both as strings. */
function readBody(body: unknown): { token: string; password: string } | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { token, password } = body as Record<string, unknown>;
  return typeof token === 'string' && typeof password === 'string'
    ? { token, password }
    : undefined;
}

/** Mount the route on `server`, the way `composeApi` mounts the hooks. */
export function mountEnrolment(server: Hono, database: Database, options: EnrolmentOptions): void {
  const tooLarge = bodyLimit({
    maxSize: ENROL_MAX_BYTES,
    onError: (context) => context.json({ code: 'ENROL_TOO_LARGE' }, 413),
  });
  server.post(ENROL_PATH, tooLarge, async (context) => {
    try {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        body = undefined;
      }
      const asked = readBody(body);
      if (asked === undefined) return context.json({ code: 'ENROL_MALFORMED' }, 400);
      const result = await acceptInvitation(
        database,
        await options.businesses(),
        options.broker,
        asked,
      );
      if (result.ok) return context.json({ state: result.state }, 200);
      return context.json({ code: result.code }, STATUS[result.code]);
    } catch {
      return context.json({ code: 'ENROL_FAULT' }, 503);
    }
  });
}
