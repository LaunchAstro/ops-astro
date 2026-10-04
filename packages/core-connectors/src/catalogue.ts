// SPDX-License-Identifier: AGPL-3.0-only
//
// The operation catalogue's registration rule: every operation declares all
// twelve declarations of the effect broker contract (section 3.2), or it does
// not register. There is no default set, and a value that would weaken the
// strictest default must be one of the named values, never a near spelling.
//
// The connector definition travels with the declaration, and the
// declaration's `connector_release` must be the digest of those bytes, so a
// connector that moved is a different release, not the same name.

import { payloadDigest } from '../../core-digest/src/index.ts';

export const DECLARATION_NAMES = [
  'operation_name',
  'connector_release',
  'effect_class',
  'reversibility_strategy',
  'acknowledgement_semantics',
  'reconcile_mode',
  'reconcile_seam',
  'nothing_happened_proof',
  'credential_tier',
  'trust_class',
  'quota_class',
  'data_flow_labels',
] as const;

export type DeclarationName = (typeof DECLARATION_NAMES)[number];

/** Section 8.1's four facts. A step settles no higher than its operation declares. */
export type Acknowledgement = 'accepted' | 'started' | 'completed' | 'landed';

export interface ReconcileSeam {
  /** The read-back operation, or `none` for a naturally idempotent one. */
  readonly read_operation: string;
  /** The reference held before dispatch that it reads by. */
  readonly reference: string;
}

export interface QuotaClass {
  readonly bucket: string;
  readonly scope: 'installation' | 'business';
  readonly cost: number;
}

export interface OperationDeclaration {
  readonly operation_name: string;
  readonly connector_release: string;
  readonly effect_class: 'transitory' | 'reversible' | 'fixed';
  readonly reversibility_strategy: 'R1' | 'R2' | 'R3' | 'R4';
  readonly acknowledgement_semantics: Acknowledgement;
  readonly reconcile_mode: 'naturally_idempotent' | 'reconcilable';
  readonly reconcile_seam: ReconcileSeam;
  readonly nothing_happened_proof: readonly string[];
  /** `none` is the capture's: no credential at all. T4 never enters the store. */
  readonly credential_tier: 'T1' | 'T2' | 'T3' | 'none';
  readonly trust_class: 'audited_in_process' | 'isolated_connector';
  readonly quota_class: QuotaClass;
  readonly data_flow_labels: readonly string[];
}

/** A response field and its type. Undeclared fields never cross back. */
export type ResponseSchema = Readonly<Record<string, 'string' | 'number' | 'boolean'>>;

export interface ConnectorDefinition {
  readonly host: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** `{name}` segments are the operation's only parameters. */
  readonly pathTemplate: string;
  /** Declared parameters sent as the JSON body. Any other parameter is refused. */
  readonly bodyParams: readonly string[];
  readonly redirects: 'none';
  readonly responseSchema: ResponseSchema;
  /** A provider status that is positive proof nothing happened, by its declared proof name. */
  readonly refusalProofs: Readonly<Record<string, string>>;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
  /** Which custody entry the call borrows; `none` borrows nothing. */
  readonly credential: 'source_control' | 'hosting' | 'none';
}

export interface OperationRegistration {
  readonly declaration: OperationDeclaration;
  readonly connector: ConnectorDefinition;
}

export type CatalogueRefusalCode =
  | 'OPERATION_DECLARATION_MISSING'
  | 'OPERATION_DECLARATION_INVALID'
  | 'CONNECTOR_RELEASE_MISMATCH'
  | 'OPERATION_ALREADY_REGISTERED'
  | 'OPERATION_NOT_ON_PATH';

export type Registered<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CatalogueRefusalCode; readonly fields: readonly string[] };

/** Each custody entry belongs to one provider host; a borrowed credential goes there and nowhere else. */
export const CREDENTIAL_HOSTS: Readonly<Record<'source_control' | 'hosting', string>> = {
  source_control: 'api.github.com',
  hosting: 'api.vercel.com',
};

export function credentialHostMatches(connector: ConnectorDefinition): boolean {
  return (
    connector.credential === 'none' || CREDENTIAL_HOSTS[connector.credential] === connector.host
  );
}

export function connectorRelease(connector: ConnectorDefinition): string {
  return `sha256:${payloadDigest(connector)}`;
}

const ONE_OF: Partial<Record<DeclarationName, readonly string[]>> = {
  effect_class: ['transitory', 'reversible', 'fixed'],
  // R5 is irreversible and prohibited: it does not register.
  reversibility_strategy: ['R1', 'R2', 'R3', 'R4'],
  acknowledgement_semantics: ['accepted', 'started', 'completed', 'landed'],
  // `neither` needs a gate that accepts a duplicate; nothing on this path has one.
  reconcile_mode: ['naturally_idempotent', 'reconcilable'],
  credential_tier: ['T1', 'T2', 'T3', 'none'],
  trust_class: ['audited_in_process', 'isolated_connector'],
};

const LABELS = new Set(['public_page', 'site_source', 'deployment_state']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}

function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => nonEmptyString(entry));
}

function validSeam(value: unknown, mode: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  const { read_operation: read, reference } = value;
  if (mode === 'naturally_idempotent') return read === 'none' && reference === 'none';
  return nonEmptyString(read) && read !== 'none' && nonEmptyString(reference);
}

function validQuota(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false;
  return (
    nonEmptyString(value['bucket']) &&
    (value['scope'] === 'installation' || value['scope'] === 'business') &&
    typeof value['cost'] === 'number' &&
    Number.isInteger(value['cost']) &&
    value['cost'] >= 0
  );
}

function invalidField(declaration: Record<string, unknown>): string | undefined {
  for (const name of DECLARATION_NAMES) {
    const value = declaration[name];
    const allowed = ONE_OF[name];
    if (allowed !== undefined && !(typeof value === 'string' && allowed.includes(value)))
      return name;
  }
  if (!nonEmptyString(declaration['operation_name'])) return 'operation_name';
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(declaration['connector_release']))) {
    return 'connector_release';
  }
  if (!validSeam(declaration['reconcile_seam'], declaration['reconcile_mode'])) {
    return 'reconcile_seam';
  }
  if (!stringList(declaration['nothing_happened_proof'])) return 'nothing_happened_proof';
  if (!validQuota(declaration['quota_class'])) return 'quota_class';
  const labels = declaration['data_flow_labels'];
  if (!stringList(labels) || !labels.every((label) => LABELS.has(label))) {
    return 'data_flow_labels';
  }
  return undefined;
}

/** One operation's registration: all twelve, each valid, the release matching its connector. */
export function registerOperation(candidate: unknown): Registered<OperationDeclaration> {
  if (!isRecord(candidate) || !isRecord(candidate['declaration'])) {
    return { ok: false, code: 'OPERATION_DECLARATION_MISSING', fields: [...DECLARATION_NAMES] };
  }
  const declaration = candidate['declaration'];
  const missing = DECLARATION_NAMES.filter(
    (name) => !Object.hasOwn(declaration, name) || declaration[name] === undefined,
  );
  if (missing.length > 0) {
    return { ok: false, code: 'OPERATION_DECLARATION_MISSING', fields: missing };
  }
  const extra = Object.keys(declaration).filter(
    (name) => !(DECLARATION_NAMES as readonly string[]).includes(name),
  );
  if (extra.length > 0) return { ok: false, code: 'OPERATION_DECLARATION_INVALID', fields: extra };
  const invalid = invalidField(declaration);
  if (invalid !== undefined) {
    return { ok: false, code: 'OPERATION_DECLARATION_INVALID', fields: [invalid] };
  }
  const connector = candidate['connector'];
  const release = isRecord(connector) ? `sha256:${payloadDigest(connector)}` : undefined;
  if (release !== declaration['connector_release']) {
    return { ok: false, code: 'CONNECTOR_RELEASE_MISMATCH', fields: ['connector_release'] };
  }
  if (!credentialHostMatches(connector as unknown as ConnectorDefinition)) {
    return { ok: false, code: 'OPERATION_DECLARATION_INVALID', fields: ['credential_tier'] };
  }
  const registered = declaration as unknown as OperationDeclaration;
  const capture = registered.credential_tier === 'none';
  if (capture !== (isRecord(connector) && connector['credential'] === 'none')) {
    return { ok: false, code: 'OPERATION_DECLARATION_INVALID', fields: ['credential_tier'] };
  }
  return { ok: true, value: registered };
}
