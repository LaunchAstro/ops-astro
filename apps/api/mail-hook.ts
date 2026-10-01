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
//
// A replayed event id is refused twice over: by this process for any event
// it took inside the timestamp window, and by the database for an event that
// moved an attempt, whichever process took it first.

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  EMAIL_HOOK_MAX_BYTES,
  EMAIL_HOOK_TOLERANCE_S,
  verifyEmailHook,
} from '../../packages/core-connectors/src/index.ts';
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
  // Every verified event id this process has taken, kept past the timestamp
  // window, so any replay inside it is refused here, whatever its type. An
  // event that landed nowhere or faulted is let go, so the provider's retry
  // can land. Across processes, a landed event's id is held in the database.
  const taken = new Map<string, number>();
  server.post(MAIL_HOOK_PATH, tooLarge, async (context) => {
    let id: string | undefined;
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
      const at = Math.floor(now() / 1000);
      for (const [held, since] of taken) {
        if (at - since > 2 * EMAIL_HOOK_TOLERANCE_S) taken.delete(held);
      }
      if (taken.has(verdict.event.id)) return context.json({ code: 'REPLAYED' }, 409);
      id = verdict.event.id;
      taken.set(id, at);
      const landed = await landEmailEvent(database, await options.businesses(), verdict.event);
      if (landed === 'UNKNOWN_MESSAGE') taken.delete(id);
      return context.json({ code: landed }, STATUS[landed]);
    } catch {
      if (id !== undefined) taken.delete(id);
      return context.json({ code: 'HOOK_FAULT' }, 503);
    }
  });
}
