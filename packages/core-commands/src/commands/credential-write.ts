// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential (API-2), two tracked actions on the person prefix only:
// `credential.issue` (`agent credential issued`) and `credential.revoke`
// (`agent credential revoked`), both under `credential:write`.
//
// An issue is always the caller's own. Its scope is the ticked keys, each held
// by the caller at business scope now, and never decide, share or manage; its
// expiry is at most `CREDENTIAL_MAX_DAYS` out. The secret is in the issue
// answer alone: the register keeps the answer with the credential nulled
// (`envelope.ts`), and the issuer's replay of the same operation derives it
// again while the credential is live (`replayIssue`).
//
// A revocation locks the row and decides under it. The issuer revokes their
// own; anyone else needs `access:manage` too, and without it another person's
// credential is NOT_FOUND, as a foreign or made-up one is. A refusal names
// the field alone: the purpose and the secret are in no refusal or detail.

import {
  checkAuthority,
  CREDENTIAL_EXCLUDED_ACTIONS,
  CREDENTIAL_MAX_DAYS,
  deriveAgentCredential,
  digestOf,
  issueAgentCredential,
  lockAgentCredential,
  revokeAgentCredential,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type {
  Action,
  CredentialKey,
  Session,
  TenantQuery,
} from '../../../core-records/src/index.ts';
import { delegationCredentialKeys } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import type { CommandHandle } from './register-store.ts';
import type { CommandRequest } from './requests.ts';

type Issue = CommandRequest & { readonly command: 'credential.issue' };
type Revoke = CommandRequest & { readonly command: 'credential.revoke' };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 32;
const MAX_PURPOSE = 200;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const COLLECTION = /^[a-z][a-z_]{0,39}$/u;
const ACTIONS: ReadonlySet<string> = new Set<Action>([
  'read',
  'comment',
  'write',
  'assign',
  'decide',
  'share',
  'manage',
]);
const EXCLUDED: ReadonlySet<string> = new Set(CREDENTIAL_EXCLUDED_ACTIONS);
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

/** The ticked keys, shaped, or undefined when any one is not a key. */
function keysOf(scope: unknown): readonly CredentialKey[] | undefined {
  if (!Array.isArray(scope) || scope.length === 0 || scope.length > MAX_KEYS) return undefined;
  const keys: CredentialKey[] = [];
  const seen = new Set<string>();
  for (const one of scope as readonly unknown[]) {
    if (typeof one !== 'object' || one === null || Array.isArray(one)) return undefined;
    const { collection, action, ...rest } = one as Readonly<Record<string, unknown>>;
    if (Object.keys(rest).length > 0) return undefined;
    if (typeof collection !== 'string' || !COLLECTION.test(collection)) return undefined;
    if (typeof action !== 'string' || !ACTIONS.has(action)) return undefined;
    const key = `${collection}:${action}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    keys.push({ collection, action: action as Action });
  }
  return keys;
}

/** The expiry, or undefined unless it is a UTC instant after now and within the limit. */
function expiryOf(expiresAt: unknown, now: number): Date | undefined {
  if (typeof expiresAt !== 'string' || !INSTANT.test(expiresAt)) return undefined;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at) || at <= now || at > now + CREDENTIAL_MAX_DAYS * DAY_MS) {
    return undefined;
  }
  return new Date(at);
}

/** The first ticked key the caller does not hold at business scope, or undefined. */
async function widening(
  tx: TenantQuery,
  session: Session,
  keys: readonly CredentialKey[],
): Promise<CredentialKey | undefined> {
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- one grant walk per key, in order
    const decision = await checkAuthority(tx, subjectsOf(session), {
      ...key,
      scope: WHOLE_BUSINESS,
    });
    if (!decision.ok) return key;
  }
  return undefined;
}

export async function issueCredential(
  tx: TenantQuery,
  context: CommandContext,
  request: Issue,
): Promise<HandlerOutcome> {
  const keys = keysOf(request.scope);
  if (keys === undefined) return invalid('scope');
  if (keys.some((key) => EXCLUDED.has(key.action))) {
    return refused(
      refuseCommand(
        'CREDENTIAL_ACTION_EXCLUDED',
        ['scope'],
        ['An agent credential never carries decide, share or manage. Untick them.'],
      ),
    );
  }
  const expiresAt = expiryOf(request.expiresAt, Date.now());
  if (expiresAt === undefined) return invalid('expiresAt');
  const { purpose } = request;
  if (typeof purpose !== 'string' || purpose.trim().length === 0 || purpose.length > MAX_PURPOSE) {
    return invalid('purpose');
  }
  const { session } = context;
  if ((await widening(tx, session, keys)) !== undefined) {
    return refused(
      refuseCommand(
        'CREDENTIAL_SCOPE_WIDENS',
        ['scope'],
        ['Tick only keys you hold across the whole business.'],
      ),
    );
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
  if (typeof credentialId !== 'string') return refused(refuseNotFound());
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
 * longer the caller's, it goes out as stored, with the credential null.
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
    held.expiresAt.getTime() <= Date.now()
  ) {
    return stored;
  }
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
