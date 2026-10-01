// SPDX-License-Identifier: AGPL-3.0-only
//
// Rows of bravo's that the identifier cases hand an alpha caller by id (C81,
// API-2, C32): written directly, so the alpha caller must not learn they exist.
// Split from `ident-audit-cases.ts` to keep that file under the line limit.

import type { World } from './world.ts';

export async function bravoRecords(world: World): Promise<{
  readonly legalVersionId: string;
  readonly credentialId: string;
  readonly clientId: string;
}> {
  // A drafted legal document version of bravo's (C81), written directly: the
  // alpha caller is handed its id and must not learn it exists.
  const bravoLegal = await world.db.admin.execute<{ readonly id: string }>(
    `insert into public.legal_document_versions
       (business_id, id, document, version, body, body_digest, drafted_by_actor)
     values ($1, gen_random_uuid(), 'breach-runbook', '1.0', 'A bravo draft.', '', $2)
     returning id`,
    [world.bravo, world.bea.actorId],
  );

  // An agent credential of bravo's (API-2), written directly: the alpha caller
  // is handed its id and must not learn it exists.
  const bravoCredential = await world.db.admin.execute<{ readonly id: string }>(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
        credential_hash, credential_scheme, credential_key_id, expires_at)
     values ($1, gen_random_uuid(), $2, $3, $2, 'A bravo credential.', array['task:read'],
             repeat('0', 64), 'hmac-sha256-v1', 'bravo', now() + interval '1 day')
     returning id`,
    [world.bravo, world.bea.actorId, world.bea.personId],
  );

  // C32: a client of bravo's, for the grant an alpha caller could name it in.
  const bravoClient = await world.db.admin.execute<{ readonly id: string }>(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, gen_random_uuid(), 'A bravo client', $2) returning id`,
    [world.bravo, world.bea.actorId],
  );

  return {
    legalVersionId: String(bravoLegal[0]?.id),
    credentialId: String(bravoCredential[0]?.id),
    clientId: String(bravoClient[0]?.id),
  };
}
