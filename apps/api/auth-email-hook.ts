// SPDX-License-Identifier: AGPL-3.0-only
//
// The login provider's Send Email hook, `POST /api/hooks/auth-email` (C39-T,
// piece P2). A system route like the email provider's (`mail-hook.ts`):
// mounted by `composeApi` only when the deployment configured its secret and
// a mail broker, outside the business prefix, with no sign-in and no person
// grant. The signature is the authority: Standard Webhooks' headers, checked
// over the raw bytes before anything is parsed, by the one verifier
// (`verifySignedHook`). Then the message is read and handed to the broker's
// `email.send` (`deliverAuthMessage`), or nothing is sent.
//
// Every verified message is answered alike, 200 and `{}`, whether it was
// sent or not: the provider's caller (a reset asked for an unknown address,
// say) learns nothing of who has an account or an invitation. A refused
// signature is 401, a malformed verified body 400, a replay 409, a fault 503;
// an answer carries a code and nothing else, and nothing is logged.
//
// A replayed message id is refused twice over: by this process for any
// message it took inside the timestamp window, and by the database for a
// message that recorded an attempt, whichever process took it first.

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  EMAIL_HOOK_MAX_BYTES,
  EMAIL_HOOK_TOLERANCE_S,
  isEmailHookSecret,
  readAuthMessage,
  STANDARD_WEBHOOK_HEADERS,
  verifySignedHook,
} from '../../packages/core-connectors/src/index.ts';
import {
  deliverAuthMessage,
  type Broker,
  type MailSettings,
} from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';

export const AUTH_EMAIL_HOOK_PATH = '/api/hooks/auth-email';

/** The hook secret's one setting, in the login provider's form `v1,whsec_...`. */
export const AUTH_EMAIL_HOOK_SECRET_SETTING = 'AUTH_EMAIL_HOOK_SECRET';

export type AuthEmailHookSettings =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly problem: string }
  | { readonly kind: 'configured'; readonly secret: string };

/** The hook's setting from the environment: the `whsec_` secret the verifier takes. */
export function authEmailHookSettings(
  environment: Readonly<Record<string, string | undefined>>,
): AuthEmailHookSettings {
  const value = environment[AUTH_EMAIL_HOOK_SECRET_SETTING] ?? '';
  if (value === '') return { kind: 'absent' };
  const secret = value.startsWith('v1,') ? value.slice('v1,'.length) : '';
  // The problem names the setting only: the value is a secret, wrong or not.
  if (!isEmailHookSecret(secret)) {
    return {
      kind: 'invalid',
      problem: `${AUTH_EMAIL_HOOK_SECRET_SETTING} is not a Send Email hook secret (v1,whsec_ and its key)`,
    };
  }
  return { kind: 'configured', secret };
}

export interface AuthEmailHookOptions {
  /** The hook secret, `whsec_...`, read once at start; never logged. */
  readonly secret: string;
  /** The deployment's businesses, the ones system work runs over. */
  readonly businesses: () => Promise<readonly BusinessId[]>;
  /** The broker the mail leaves through, and who it is from. */
  readonly broker: Broker;
  readonly mail: MailSettings;
  /** The clock, in milliseconds; a test moves it. */
  readonly now?: () => number;
}

/** Mount the hook on `server`, the way `composeApi` does. */
export function mountAuthEmailHook(
  server: Hono,
  database: Database,
  options: AuthEmailHookOptions,
): void {
  const now = options.now ?? Date.now;
  const tooLarge = bodyLimit({
    maxSize: EMAIL_HOOK_MAX_BYTES,
    onError: (context) => context.json({ code: 'HOOK_TOO_LARGE' }, 413),
  });
  // Every verified message id this process has taken, kept past the window.
  const taken = new Map<string, number>();
  server.post(AUTH_EMAIL_HOOK_PATH, tooLarge, async (context) => {
    let id: string | undefined;
    try {
      const raw = new Uint8Array(await context.req.raw.arrayBuffer());
      const headers = context.req.raw.headers;
      const at = Math.floor(now() / 1000);
      const verdict = verifySignedHook(
        raw,
        (name) => headers.get(name),
        options.secret,
        at,
        STANDARD_WEBHOOK_HEADERS,
      );
      if (!verdict.ok) return context.json({ code: verdict.code }, 401);
      const message = readAuthMessage(raw);
      if (message === undefined) return context.json({ code: 'HOOK_MALFORMED' }, 400);
      for (const [held, since] of taken) {
        if (at - since > 2 * EMAIL_HOOK_TOLERANCE_S) taken.delete(held);
      }
      if (taken.has(verdict.id)) return context.json({ code: 'REPLAYED' }, 409);
      id = verdict.id;
      taken.set(id, at);
      const businesses = await options.businesses();
      const landed = await deliverAuthMessage(database, businesses, options.broker, options.mail, {
        ...message,
        id,
      });
      if (landed === 'REPLAYED') return context.json({ code: 'REPLAYED' }, 409);
      return context.json({}, 200);
    } catch {
      if (id !== undefined) taken.delete(id);
      return context.json({ code: 'HOOK_FAULT' }, 503);
    }
  });
}
