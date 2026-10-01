// SPDX-License-Identifier: AGPL-3.0-only
//
// Two of the API's person-facing pieces that need nothing of the door in
// app.ts: the public legal documents (C81) and the sign-out a business
// refused that still ends its session (C58). Moved out of app.ts whole when
// batch 2b joined it past the 1000-line limit.

import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  endProviderSession,
  PUBLIC_LEGAL_DOCUMENTS,
  readPublishedLegal,
} from '../../packages/core-records/src/index.ts';
import type {
  Database,
  LegalDocument,
  VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import {
  endOtherSessions,
  enrolSecondFactor,
  isCommandRefusal,
  listOwnSessions,
  removeSecondFactor,
  signOutSession,
  verifySecondFactor,
} from '../../packages/core-commands/src/index.ts';
import type { CommandRefusal, FactorProvider } from '../../packages/core-commands/src/index.ts';
import { bearerOf, sessionCookieOf } from './auth/session.ts';
import { PUBLIC_PREFIX } from '../../packages/core-wire/src/index.ts';

/** What the public legal read needs of the API's options. */
interface PublicLegalOptions {
  readonly database: Database;
  readonly resolveBusiness: (businessKey: string) => Promise<string | undefined>;
}

/**
 * A business's published legal documents (C81), read with no sign-in: the
 * version published most recently, its words and their digest. No business,
 * nothing published, the breach runbook (the operators' own) and a name that
 * is no document are one answer, so the address tells an outsider nothing
 * about which businesses exist or what they have drafted.
 */
export function mountPublicLegal(api: Hono, options: PublicLegalOptions): void {
  const PUBLIC: ReadonlySet<string> = new Set(PUBLIC_LEGAL_DOCUMENTS);
  api.get(`${PUBLIC_PREFIX}:businessKey/legal/:document`, async (context) => {
    const document = context.req.param('document');
    const businessId = PUBLIC.has(document)
      ? await options.resolveBusiness(context.req.param('businessKey'))
      : undefined;
    const published =
      businessId === undefined
        ? undefined
        : await options.database.withBusiness(
            businessId,
            async (tx) => await readPublishedLegal(tx, document as LegalDocument),
          );
    if (published === undefined) return context.json({ code: 'NOT_FOUND' }, 404);
    return context.json({ ...published, publishedAt: published.publishedAt.toISOString() }, 200);
  });
}

/**
 * C58: a sign-out this business refused (it no longer admits the person, say)
 * still ends the verified token's own session in every business, then at the
 * provider. The door has checked the token and the cross-site rule; a token
 * naming no session ends nothing, and the refusal is still answered.
 */
export async function signOutRefused(
  options: { readonly database: Database },
  caller: {
    readonly businessId: string;
    readonly presented: VerifiedSubject;
    readonly accessToken: string;
  },
  factors: FactorProvider,
): Promise<void> {
  const { sessionId } = caller.presented;
  if (sessionId === undefined) return;
  await options.database.withBusiness(caller.businessId, async (tx) => {
    await endProviderSession(tx, sessionId);
  });
  await factors.signOut(caller.accessToken, 'local');
}

/** What the API lends the account routes: its door on the person prefix, and its refusal. */
export interface AccountDoor {
  readonly prefix: string;
  readonly admit: (context: Context) => Promise<
    | Response
    | {
        readonly businessId: string;
        readonly presented: VerifiedSubject;
        readonly body: Readonly<Record<string, unknown>>;
      }
  >;
  readonly refuse: (context: Context, refusal: CommandRefusal) => Response;
  readonly unknownLogin: () => CommandRefusal;
}

/**
 * The person's own account routes (C58, C59): the second factor and their
 * sessions, each through the person prefix's door and its business.
 */
export function mountFactorRoutes(
  api: Hono,
  options: { readonly database: Database },
  factors: FactorProvider,
  door: AccountDoor,
): void {
  const routes = new Hono();
  type Caller = Parameters<typeof enrolSecondFactor>[0];
  const acts = {
    'factor/enrol': async (caller: Caller) => await enrolSecondFactor(caller, factors),
    'factor/verify': async (caller: Caller, body: unknown) =>
      await verifySecondFactor(caller, body, factors),
    'factor/remove': async (caller: Caller, body: unknown) =>
      await removeSecondFactor(caller, body, factors),
    'sessions/list': async (caller: Caller, body: unknown) => await listOwnSessions(caller, body),
    'sessions/end-others': async (caller: Caller, body: unknown) =>
      await endOtherSessions(caller, body, factors),
    'sessions/sign-out': async (caller: Caller, body: unknown) =>
      await signOutSession(caller, body, factors),
  } as const;
  for (const [name, act] of Object.entries(acts)) {
    routes.post(`/account/${name}`, async (context) => {
      const admitted = await door.admit(context);
      if (admitted instanceof Response) return admitted;
      // The person's own token, as the door took it: the bearer, or the browser's session cookie.
      const accessToken = bearerOf(context.req) ?? sessionCookieOf(context.req);
      if (accessToken === undefined) {
        return door.refuse(context, door.unknownLogin());
      }
      const caller = {
        database: options.database,
        businessId: admitted.businessId,
        presented: admitted.presented,
        accessToken,
      };
      const result = await act(caller, admitted.body);
      if (isCommandRefusal(result)) {
        if (name === 'sessions/sign-out' && result.code !== 'COMMAND_BODY_INVALID') {
          await signOutRefused(options, caller, factors);
        }
        return door.refuse(context, result);
      }
      return context.json(result, 200);
    });
  }
  api.route(`${door.prefix}:businessKey`, routes);
}
