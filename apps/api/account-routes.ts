// SPDX-License-Identifier: AGPL-3.0-only
//
// Two of the API's person-facing pieces that need nothing of the door in
// app.ts: the public legal documents (C81) and the sign-out a business
// refused that still ends its session (C58). Moved out of app.ts whole when
// batch 2b joined it past the 1000-line limit.

import type { Hono } from 'hono';
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
import type { FactorProvider } from '../../packages/core-commands/src/index.ts';
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
