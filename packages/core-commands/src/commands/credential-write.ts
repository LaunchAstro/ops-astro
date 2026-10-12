// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential (API-2), two tracked actions on the person prefix only:
// `credential.issue` (`agent credential issued`) and `credential.revoke`
// (`agent credential revoked`), both under `credential:write`.
//
// An issue is always the caller's own. Its scope is the ticked keys, each held
// by the caller at business scope now, and never a key no agent may hold
// (`credential-scope.ts`): every credential is an agent's. The keys are judged
// under the business's access lock, which access.end takes too, so an issue
// either sees the ending and is refused or lands before it and is revoked by
// it. Its expiry is at most `CREDENTIAL_MAX_DAYS` out, judged on the database
// clock that stamps `issued_at`. The secret is in the issue answer alone: the
// register keeps the answer with the credential nulled (`envelope.ts`), and
// the issuer's replay of the same operation derives it again while the
// credential is live and its keys would be issued again (`replayIssue`).
//
// A revocation locks the row and decides under it. The issuer revokes their
// own; anyone else needs `access:manage` too, and without it another person's
// credential is NOT_FOUND, as a foreign or made-up one is. A refusal names
// the field alone: the purpose and the secret are in no refusal or detail.

import {
  advisoryLock,
  checkAuthority,
  CREDENTIAL_MAX_DAYS,
  deriveAgentCredential,
  digestOf,
  ENDED_FIXES,
  issueAgentCredential,
  isUuid,
  lockAccess,
  lockAgentCredential,
  revokeAgentCredential,
  sessionEndedSince,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { delegationCredentialKeys } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import {
  databaseClock,
  keysOf,
  MAX_KEYS,
  refuseNeverCarried,
  refuseScope,
  storedKeys,
} from './credential-scope.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import type { CommandHandle } from './register-store.ts';
import type { CommandRequest } from './requests.ts';
import { isTimestamp } from './values.ts';

type Issue = CommandRequest & { readonly command: 'credential.issue' };
type Revoke = CommandRequest & { readonly command: 'credential.revoke' };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PURPOSE = 200;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const WHOLE_BUSINESS = { kind: 'business', id: null } as const;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  scope: [`Send 1 to ${String(MAX_KEYS)} distinct { collection, action } keys.`],
  expiresAt: [
    `Send an ISO 8601 UTC time after now and at most ${String(CREDENTIAL_MAX_DAYS)} days out.`,
  ],
  purpose: [`Send what the credential is for, 1 to ${String(MAX_PURPOSE)} characters.`],
};

const invalid = (field: string) =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

const NO_KEY = refuseCommand(
  'DEPENDENCY_NOT_LANDED',
  ['credential.issue', 'DELEGATION_CREDENTIAL_KEY_ID and DELEGATION_CREDENTIAL_KEYS'],
  [
    'This deployment has no usable delegation credential key.',
    'It is not a permission problem and retrying will not change it.',
  ],
);

/**
 * The expiry, or undefined unless it is a real UTC instant after now and within
 * the limit: never a 30 February `Date.parse` would roll into March (#522).
 */
function expiryOf(expiresAt: unknown, now: number): Date | undefined {
  if (typeof expiresAt !== 'string' || !INSTANT.test(expiresAt) || !isTimestamp(expiresAt)) {
    return undefined;
  }
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at) || at <= now || at > now + CREDENTIAL_MAX_DAYS * DAY_MS) {
    return undefined;
  }
  return new Date(at);
}

export async function issueCredential(
  tx: TenantQuery,
  context: CommandContext,
  request: Issue,
): Promise<HandlerOutcome> {
  const keys = keysOf(request.scope);
  if (keys === undefined) return invalid('scope');
  const never = refuseNeverCarried(keys);
  if (never !== undefined) return refused(never);
  // Its shape and ceiling before any lock, on the transaction's clock; the
  // database holds the ceiling again against the issue it stamps at insert.
  const expiresAt = expiryOf(request.expiresAt, await databaseClock(tx, 'now()'));
  if (expiresAt === undefined) return invalid('expiresAt');
  const { purpose } = request;
  if (typeof purpose !== 'string' || purpose.trim().length === 0 || purpose.length > MAX_PURPOSE) {
    return invalid('purpose');
  }
  const { session } = context;
  await lockAccess(tx);
  const scopeRefusal = await refuseScope(tx, session, keys);
  if (scopeRefusal !== undefined) return refused(scopeRefusal);
  // An expiry that passed while the issue waited on the access lock mints nothing.
  if (expiresAt.getTime() <= (await databaseClock(tx, 'clock_timestamp()'))) {
    return invalid('expiresAt');
  }
  const held = delegationCredentialKeys();
  if (!held.ok) return refused(NO_KEY);
  const issued = await issueAgentCredential(tx, held.keys, {
    personId: session.personId,
    actorId: session.actorId,
    purpose,
    scope: keys,
    expiresAt,
  });
  return applied(issued.credentialId, null, {
    credentialId: issued.credentialId,
    agentActorId: issued.agentActorId,
    scope: keys,
    expiresAt: expiresAt.toISOString(),
    // In the clear only in this answer; the register keeps it nulled.
    credential: issued.credential,
  });
}

export async function revokeCredential(
  tx: TenantQuery,
  context: CommandContext,
  request: Revoke,
): Promise<HandlerOutcome> {
  const { credentialId } = request;
  // A malformed id is not found, as a made-up one is, before the uuid cast.
  if (typeof credentialId !== 'string' || !isUuid(credentialId)) return refused(refuseNotFound());
  const held = await lockAgentCredential(tx, credentialId);
  if (held === undefined) return refused(refuseNotFound());
  const { session } = context;
  if (held.issuedByPersonId !== session.personId) {
    const manage = await checkAuthority(tx, subjectsOf(session), {
      collection: 'access',
      action: 'manage',
      scope: WHOLE_BUSINESS,
    });
    // Another person's credential is theirs: without access:manage it is not
    // found, as a foreign one is.
    if (!manage.ok) return refused(refuseNotFound());
  }
  const refusal = await revokeAgentCredential(tx, held, session.actorId);
  if (refusal !== undefined) {
    return refused(
      refuseCommand('CREDENTIAL_ALREADY_REVOKED', [], ['Nothing to do: it is revoked already.']),
    );
  }
  return applied(credentialId, null, { credentialId });
}

/**
 * The issuer's replay of an issue: the stored answer, with the secret derived
 * again while the credential is theirs and live. Revoked, expired or no
 * longer the caller's, it goes out as stored, with the credential null. A
 * live one whose keys an issue of it would now refuse (a key no agent may
 * hold, issued before the rule, or one the issuer no longer holds) is
 * refused as that issue is.
 */
export async function replayIssue(
  tx: TenantQuery,
  session: Session,
  stored: CommandHandle,
): Promise<CommandHandle | CommandRefusal> {
  const named = stored.detail['credentialId'];
  const held = typeof named === 'string' ? await lockAgentCredential(tx, named) : undefined;
  if (
    held === undefined ||
    held.issuedByPersonId !== session.personId ||
    held.revokedAt !== null ||
    // On the database's clock, read after the row's lock wait.
    held.expiresAt.getTime() <= (await databaseClock(tx, 'clock_timestamp()'))
  ) {
    return stored;
  }
  // The session and the keys asked again after the last wait, the audit
  // chain's key, its ending keys held to commit after it (`ending-keys.ts`):
  // no secret for a signed-out caller. The secret again is an issue again:
  // its keys judged as an issue's are, under the access lock, against the
  // issuer's grants as they stand after that wait, so a grant that ran out
  // while it waited refuses the replay.
  await advisoryLock(tx, tx.businessId.toLowerCase());
  if (await sessionEndedSince(tx, session)) {
    return refuseCommand('AUTH_SESSION_EXPIRED', [], ENDED_FIXES);
  }
  const scope = storedKeys(held.scope);
  const refusal = refuseNeverCarried(scope) ?? (await refuseScope(tx, session, scope));
  if (refusal !== undefined) return refusal;
  const keys = delegationCredentialKeys();
  const credential = keys.ok
    ? deriveAgentCredential(keys.keys, held.keyId, tx.businessId, held)
    : undefined;
  if (credential === undefined || digestOf(credential) !== held.credentialHash) {
    return refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      ['credential.issue', `delegation credential key ${held.keyId}`],
      [
        'This deployment does not hold the key this credential was issued under.',
        'Restore that key; the issue is unchanged and replays once it is back.',
      ],
    );
  }
  return { ...stored, detail: { ...stored.detail, credential } };
}
