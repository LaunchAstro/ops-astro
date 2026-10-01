// SPDX-License-Identifier: AGPL-3.0-only
//
// Who a call presents itself as, before the door admits it: the sign-in
// provider's verified subject, or on the agent prefix an agent credential
// (API-2), which never reaches the provider.

import type { Context } from 'hono';
import {
  NO_ASSURANCE,
  credentialSubject,
  isAgentCredentialForm,
} from '../../../packages/core-records/src/index.ts';
import { bearerOf } from './session.ts';
import type { Verifier } from './supabase.ts';

/**
 * On the agent prefix a bearer and nothing else: a session cookie is never
 * read there (API-2 bearer only, S0-6). A bearer in the agent credential's
 * form is the product's own scheme and never reaches the sign-in provider's
 * verifier; it stands here as the digest of its digest (`credentialSubject`),
 * so no log or detector holds it or a slice of its stored hash.
 */
export async function presentedBy(
  verify: Verifier,
  request: Context['req'],
  agentPrefix: boolean,
): Promise<{
  readonly presented: Awaited<ReturnType<Verifier>>;
  readonly credential?: string;
}> {
  if (!agentPrefix) return { presented: await verify(request) };
  const token = bearerOf(request);
  // No bearer is no credential: the agent prefix reads no cookie (API-2).
  if (token === undefined) return { presented: 'absent' };
  if (!isAgentCredentialForm(token)) return { presented: await verify(request) };
  const digest = {
    provider: 'agent-credential',
    subject: credentialSubject(token),
    assurance: NO_ASSURANCE,
  };
  return { presented: digest, credential: token };
}
