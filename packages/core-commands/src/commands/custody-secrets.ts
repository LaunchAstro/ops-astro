// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's two writes (C31): `secret.set` and `secret.clear`.
//
// One command family serves both secret screens. The envelope has already
// checked `custody:manage` business-wide and refused every agent (the row is
// `agent: never`), so what is left here is the value itself: checked by kind
// and size, refused if it is a chat product's browser session (custody's own
// load check), sealed to the broker's key, and never repeated back. A refusal
// names the field, never what arrived in it, and the audit event and the
// repeat-request register hold only the body's digest (0007).

import {
  clearSecret,
  isSecretStale,
  isUuid,
  readSecret,
  setSecret,
  type SecretScope,
  type SecretStale,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { parseCredentials } from '../../../core-custody/src/index.ts';
import { custodySealingKey } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const NAME_SHAPE = /^[a-z][a-z0-9_.-]{1,99}$/u;
/** A credential, a token or a key file's text; nothing a person pastes is longer. */
const VALUE_LIMIT = 8_192;

const NAME_FIXES = ['Name a secret in lower case: letters, digits, dot, dash or underscore.'];
const VALUE_FIXES = [`Send the value as text of 1 to ${VALUE_LIMIT} characters.`];
const SESSION_FIXES = [
  "A chat product's browser session is never stored. Send an API key or a cloud provider credential.",
];
const REVISION_FIXES = [
  'Send expectedRevision as the whole number secret.list showed, or leave it out.',
];
const CLIENT_FIXES = [
  "Send clientId as the client's identifier, or leave it out for the whole business.",
];
const NO_KEY_FIXES = [
  'This deployment has no custody key to seal a secret to.',
  'It is not a permission problem and retrying will not change it.',
];

type Revision = { readonly ok: true; readonly value: number | undefined } | { readonly ok: false };

function revisionOf(value: unknown): Revision {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1)
    return { ok: true, value };
  return { ok: false };
}

/**
 * Whether a value is, or carries, a consumer chat product's session (AW-01,
 * C60): custody refuses one at load before any other check, so its answer on
 * a one-entry list is the product's one rule.
 */
function isChatSession(value: string): boolean {
  const read = parseCredentials([{ kind: 'api_key', value }]);
  return !read.ok && read.code === 'SESSION_TOKEN_REFUSED';
}

type Value =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly refusal: HandlerOutcome };

/** The value as text of the allowed size, and never a chat product's session. */
function valueOf(value: unknown): Value {
  if (typeof value !== 'string' || value.length === 0 || value.length > VALUE_LIMIT) {
    return {
      ok: false,
      refusal: refused(refuseCommand('FIELD_VALUE_INVALID', ['value'], VALUE_FIXES)),
    };
  }
  if (isChatSession(value)) {
    return {
      ok: false,
      refusal: refused(refuseCommand('FIELD_VALUE_INVALID', ['value'], SESSION_FIXES)),
    };
  }
  return { ok: true, value };
}

function stale(found: SecretStale): HandlerOutcome {
  return refused(
    refuseCommand(
      'VERSION_STALE',
      [`revision=${found.revision}`],
      ['Read the secret again and set it against the revision it is at now.'],
    ),
  );
}

/** Seal and store one secret, business-wide or for one client. */
export async function setCustodySecret(
  tx: TenantQuery,
  context: CommandContext,
  request: {
    readonly name: string;
    readonly value: unknown;
    readonly clientId?: string | null;
    readonly expectedRevision?: unknown;
  },
): Promise<HandlerOutcome> {
  if (!NAME_SHAPE.test(request.name)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['name'], NAME_FIXES));
  }
  const value = valueOf(request.value);
  if (!value.ok) return value.refusal;
  const revision = revisionOf(request.expectedRevision);
  if (!revision.ok) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['expectedRevision'], REVISION_FIXES));
  }
  const key = custodySealingKey();
  if (key === undefined) {
    return refused(
      refuseCommand('DEPENDENCY_NOT_LANDED', ['secret.set', 'custody key'], NO_KEY_FIXES),
    );
  }
  const clientId = request.clientId ?? null;
  if (clientId !== null && !isUuid(clientId)) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['clientId'], CLIENT_FIXES));
  }
  const scope: SecretScope =
    clientId === null ? { kind: 'business', id: null } : { kind: 'party', id: clientId };
  const written = await setSecret(tx, {
    name: request.name,
    scope,
    value: value.value,
    key,
    actorId: context.session.actorId,
    ...(revision.value === undefined ? {} : { expectedRevision: revision.value }),
  });
  if (isSecretStale(written)) return stale(written);
  return applied(written.id, written.revision, {
    secretId: written.id,
    name: request.name,
    clientId,
    state: 'set',
  });
}

/** Clear one secret's value, keeping its row and who set and cleared it. */
export async function clearCustodySecret(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly secretId: string; readonly expectedRevision?: unknown },
): Promise<HandlerOutcome> {
  const revision = revisionOf(request.expectedRevision);
  if (!revision.ok) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['expectedRevision'], REVISION_FIXES));
  }
  // Another business's secret is not in this transaction's rows at all (RLS),
  // so it answers exactly as a fabricated or malformed identifier does.
  if (!isUuid(request.secretId)) return refused(refuseNotFound());
  if ((await readSecret(tx, request.secretId)) === undefined) return refused(refuseNotFound());
  const cleared = await clearSecret(tx, {
    id: request.secretId,
    actorId: context.session.actorId,
    ...(revision.value === undefined ? {} : { expectedRevision: revision.value }),
  });
  if (cleared === undefined) return refused(refuseNotFound());
  if (isSecretStale(cleared)) return stale(cleared);
  return applied(cleared.id, cleared.revision, { secretId: cleared.id, state: 'not set' });
}
