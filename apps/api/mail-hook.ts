// SPDX-License-Identifier: AGPL-3.0-only
//
// The email provider's hook route, `POST /api/hooks/email` (AW-07b hook
// signature). A system route like `/api/identity`: mounted by `composeApi`
// only when the deployment configured a hook secret, outside the business
// prefix, with no sign-in and no person grant. The signature is the
// authority, checked over the raw bytes before anything is parsed
// (`verifyEmailHook`), and the one write it can lead to is a delivery
// observation on the attempt the event names (`landEmailEvent`).
//
// An answer carries a code and nothing else: never the body, a header, the
// secret or a fault's text, and nothing is logged. A refused signature is 401,
// a malformed verified body 400, a replay 409, an event for no message sent
// here 404 (so the provider retries one that raced the send's commit), and a
// fault 503.

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { EMAIL_HOOK_MAX_BYTES, verifyEmailHook } from '../../packages/core-connectors/src/index.ts';
import { landEmailEvent, type EmailHookOutcome } from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';

export const MAIL_HOOK_PATH = '/api/hooks/email';

export interface MailHookOptions {
  /** The hook secret, `whsec_...`, read once at start; never logged. */
  readonly secret: string;
  /** The deployment's businesses, the ones system work runs over. */
  readonly businesses: () => Promise<readonly BusinessId[]>;
  /** The clock, in milliseconds; a test moves it. */
  readonly now?: () => number;
}

const STATUS: Readonly<Record<EmailHookOutcome, 200 | 404 | 409>> = {
  DELIVERED: 200,
  BOUNCED: 200,
  UNCHANGED: 200,
  IGNORED: 200,
  REPLAYED: 409,
  UNKNOWN_MESSAGE: 404,
};

/** Mount the hook on `server`, the way `composeApi` does. */
export function mountMailHook(server: Hono, database: Database, options: MailHookOptions): void {
  const now = options.now ?? Date.now;
  const tooLarge = bodyLimit({
    maxSize: EMAIL_HOOK_MAX_BYTES,
    onError: (context) => context.json({ code: 'HOOK_TOO_LARGE' }, 413),
  });
  server.post(MAIL_HOOK_PATH, tooLarge, async (context) => {
    try {
      const raw = new Uint8Array(await context.req.raw.arrayBuffer());
      const headers = context.req.raw.headers;
      const verdict = verifyEmailHook(
        raw,
        (name) => headers.get(name),
        options.secret,
        Math.floor(now() / 1000),
      );
      if (!verdict.ok) {
        return context.json({ code: verdict.code }, verdict.code === 'HOOK_MALFORMED' ? 400 : 401);
      }
      const landed = await landEmailEvent(database, await options.businesses(), verdict.event);
      return context.json({ code: landed }, STATUS[landed]);
    } catch {
      return context.json({ code: 'HOOK_FAULT' }, 503);
    }
  });
}
