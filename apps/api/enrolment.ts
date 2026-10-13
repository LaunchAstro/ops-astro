// SPDX-License-Identifier: AGPL-3.0-only
//
// `POST /api/enrol` (C39-T): the enrolment page sends the link's one-time
// token, and the invitation is accepted (`acceptInvitation`). Outside the
// business prefix, with no sign-in, no person grant and no session: the token
// is the authority. No cookie is read or set, no password is asked for or
// taken, and nothing is answered but a code: the person sets their password
// from the link the M5 unit mails once it has made their login.
//
// Answers carry a code and nothing else, and nothing is logged: 200
// `{ accepted: true }`; 401 `ENROLMENT_LINK_INVALID` for every link that is
// not live, whatever the reason; 409 `ENROLMENT_NOT_YET` while the
// installation's first-client gate refuses invitations; 400
// `ENROLMENT_MALFORMED` for a body that is not one; 413 `ENROLMENT_TOO_LARGE`;
// 503 `ENROLMENT_FAULT` otherwise.

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { acceptInvitation, type AcceptCode } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

export const ENROL_API_PATH = '/api/enrol';

/** A token and room for its JSON, no more. */
const ENROL_MAX_BYTES = 256;

const STATUS: Readonly<Record<AcceptCode, 401 | 409>> = {
  ENROLMENT_LINK_INVALID: 401,
  ENROLMENT_NOT_YET: 409,
};

/** The token, when the body is one JSON object holding it as a string. */
async function tokenOf(request: Request): Promise<string | undefined> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const { token } = body as Record<string, unknown>;
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Mount the route on `server`, the way `composeApi` mounts the hooks. */
export function mountEnrolment(server: Hono, database: Database): void {
  const tooLarge = bodyLimit({
    maxSize: ENROL_MAX_BYTES,
    onError: (context) => context.json({ code: 'ENROLMENT_TOO_LARGE' }, 413),
  });
  server.post(ENROL_API_PATH, tooLarge, async (context) => {
    try {
      const token = await tokenOf(context.req.raw);
      if (token === undefined) return context.json({ code: 'ENROLMENT_MALFORMED' }, 400);
      const result = await acceptInvitation(database, token);
      if (result.ok) return context.json({ accepted: true }, 200);
      return context.json({ code: result.code }, STATUS[result.code]);
    } catch {
      return context.json({ code: 'ENROLMENT_FAULT' }, 503);
    }
  });
}
