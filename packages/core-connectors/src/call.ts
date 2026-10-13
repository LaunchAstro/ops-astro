// SPDX-License-Identifier: AGPL-3.0-only
//
// One catalogued call to a provider, as the connector definition says and
// nothing the caller adds: the listed host, the declared parameters, no
// redirect followed, the byte cap and deadline, the response checked against
// its schema and filtered to its declared fields. A write whose answer cannot
// be read is unknown, never a success and never a failure: the provider may
// have acted. The credential goes to the provider and nowhere else; no result
// or record carries a provider's words. A reference in place of a token sends
// the call bare to custody, which adds the credential and withholds any echo of it.

import type { OperationRegistration } from './catalogue.ts';
import { connectorRelease, credentialHostMatches } from './catalogue.ts';
import {
  familyOf,
  isDeniedAddress,
  type Resolver,
  type Transport,
  type TransportAnswer,
  type TransportRequest,
} from './capture/transport.ts';
import { CONNECTOR_HOSTS } from './site/operations.ts';

export type ProviderValue = Readonly<Record<string, string | number | boolean>>;

export type ProviderResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly code: string; readonly proof?: string }
  | { readonly kind: 'unknown'; readonly code: string };

export type ConnectorResult = ProviderResult<ProviderValue>;

/** A custody entry by name, never its value. */
export interface CredentialReference {
  readonly ref: 'source_control' | 'hosting';
}

/** Custody's answer: the provider's, a refusal before sending, or one withheld after sending. */
export type CustodyAnswer = TransportAnswer | { kind: 'refused' | 'withheld'; code: string };

type Send = (request: TransportRequest) => Promise<CustodyAnswer>;

export interface CallDependencies {
  readonly transport: Transport;
  readonly resolve: Resolver;
  /** Borrows the named entry for this one call, or answers a reference for `custody` to send by. */
  readonly credential: (entry: CredentialReference['ref']) => Promise<string | CredentialReference>;
  readonly custody?: (request: TransportRequest, to: CredentialReference) => ReturnType<Send>;
  /** Every refusal and unknown on the path, by code (Receipt L field 14). */
  readonly record: (code: string) => void;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/u;

function validSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== '.' && value !== '..';
}

/** A many-segment slot with a fixed shape: a repository is its owner and name, nothing deeper. */
export const SLOT_SEGMENTS: ReadonlyMap<string, number> = new Map([['repository', 2]]);

/** The request path, or the refusal code for the parameters. */
function buildPath(
  template: string,
  params: Readonly<Record<string, string>>,
  bodyParams: readonly string[],
): { path: string } | { code: string } {
  const slots = [...template.matchAll(/\{([a-z]+)(\*?)\}/gu)];
  const declared = new Set([...slots.map((slot) => slot[1] ?? ''), ...bodyParams]);
  if (Object.keys(params).some((name) => !declared.has(name)))
    return { code: 'PARAMETER_NOT_DECLARED' };
  let path = template;
  for (const [slot, name = '', many] of slots) {
    const value = params[name];
    if (typeof value !== 'string') return { code: 'PARAMETER_INVALID' };
    const segments = many === '*' ? value.split('/') : [value];
    const fixed = SLOT_SEGMENTS.get(name);
    if (many === '*' && fixed !== undefined && segments.length !== fixed)
      return { code: 'PARAMETER_INVALID' };
    if (!segments.every((segment) => validSegment(segment))) return { code: 'PARAMETER_INVALID' };
    path = path.replace(slot, segments.map((segment) => encodeURIComponent(segment)).join('/'));
  }
  return { path };
}

/** A dotted field; a list is read only by a numeric index (`deployments.0.uid`). */
export function readField(body: unknown, dotted: string): unknown {
  let value: unknown = body;
  for (const part of dotted.split('.')) {
    if (Array.isArray(value)) {
      value = /^(?:0|[1-9][0-9]{0,5})$/u.test(part)
        ? (value as unknown[])[Number(part)]
        : undefined;
      continue;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    value = Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
  }
  return value;
}

type Prepared =
  | { readonly request: TransportRequest; readonly secret?: string; readonly send: Send }
  | { readonly refused: string };

function requestFor(
  registration: OperationRegistration,
  params: Readonly<Record<string, string>>,
  path: string,
  address: string,
  token: string | undefined,
): TransportRequest {
  const { connector } = registration;
  const write = connector.method !== 'GET';
  const body = Object.fromEntries(
    connector.bodyParams.flatMap((name) =>
      params[name] === undefined ? [] : [[name, params[name]]],
    ),
  );
  const url = new URL(`https://${connector.host}${path}`);
  // A read carries its declared parameters as the query (a source read's pinned ref).
  if (!write) for (const [name, value] of Object.entries(body)) url.searchParams.set(name, value);
  return {
    url,
    address,
    family: familyOf(address),
    method: connector.method,
    headers: {
      accept: 'application/json',
      'user-agent': 'site-connector',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(write ? { 'content-type': 'application/json' } : {}),
    },
    ...(write ? { body: new TextEncoder().encode(JSON.stringify(body)) } : {}),
    timeoutMs: connector.timeoutMs,
    maxBytes: connector.maxResponseBytes,
  };
}

/** Everything checked before a byte leaves: host, credential binding, release, parameters, address. */
async function prepare(
  registration: OperationRegistration,
  params: Readonly<Record<string, string>>,
  deps: CallDependencies,
): Promise<Prepared> {
  const { connector, declaration } = registration;
  if (!CONNECTOR_HOSTS.includes(connector.host)) return { refused: 'DESTINATION_NOT_LISTED' };
  if (!credentialHostMatches(connector)) return { refused: 'CREDENTIAL_HOST_MISMATCH' };
  if (connectorRelease(connector) !== declaration.connector_release) {
    return { refused: 'CONNECTOR_RELEASE_UNAVAILABLE' };
  }
  const built = buildPath(connector.pathTemplate, params, connector.bodyParams);
  if ('code' in built) return { refused: built.code };
  let address: string;
  try {
    const answers = await deps.resolve(connector.host);
    if (answers.length === 0 || answers.some((answer) => isDeniedAddress(answer))) {
      return { refused: 'DESTINATION_ADDRESS_DENIED' };
    }
    address = answers[0] ?? '';
  } catch {
    return { refused: 'PROVIDER_UNREACHABLE' };
  }
  let token: string | undefined;
  let send: Send = deps.transport;
  if (connector.credential !== 'none') {
    const { custody } = deps;
    try {
      const held = await deps.credential(connector.credential);
      if (typeof held === 'string') token = held;
      // A reference names this call's own entry and goes to custody, or nothing is sent.
      else if (held.ref === connector.credential && custody !== undefined)
        send = async (request) => await custody(request, held);
      else return { refused: 'CREDENTIAL_UNAVAILABLE' };
    } catch {
      return { refused: 'CREDENTIAL_UNAVAILABLE' };
    }
  }
  const request = requestFor(registration, params, built.path, address, token);
  return { request, send, ...(token === undefined ? {} : { secret: token }) };
}

type Read =
  | { readonly value: ProviderValue }
  | { readonly unreadable: string }
  | { readonly refused: string; readonly proof: string };
const ECHOED: Read = { unreadable: 'PROVIDER_CREDENTIAL_ECHOED' };

/** What the answer establishes. Nothing of the provider's own words crosses back. */
function readAnswer(registration: OperationRegistration, answer: TransportAnswer): Read {
  const { connector, declaration } = registration;
  if (answer.kind === 'timeout') return { unreadable: 'PROVIDER_TIMEOUT' };
  if (answer.kind === 'oversized') return { unreadable: 'PROVIDER_RESPONSE_OVERSIZED' };
  if (answer.kind !== 'answer') return { unreadable: 'PROVIDER_CONNECTION_LOST' };
  if (answer.status >= 300 && answer.status < 400)
    return { unreadable: 'PROVIDER_REDIRECT_REFUSED' };
  const proof = connector.refusalProofs[String(answer.status)];
  if (proof !== undefined && declaration.nothing_happened_proof.includes(proof)) {
    return { refused: 'PROVIDER_REFUSED', proof };
  }
  if (answer.status < 200 || answer.status >= 300)
    return { unreadable: 'PROVIDER_STATUS_UNEXPECTED' };
  const type = (answer.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return { unreadable: 'PROVIDER_RESPONSE_MALFORMED' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(answer.body));
  } catch {
    return { unreadable: 'PROVIDER_RESPONSE_MALFORMED' };
  }
  const value: Record<string, string | number | boolean> = {};
  for (const [field, kind] of Object.entries(connector.responseSchema)) {
    const read = readField(parsed, field);
    // oxlint-disable-next-line valid-typeof -- `kind` is the schema's own type name
    if (typeof read !== kind) return { unreadable: 'PROVIDER_RESPONSE_SCHEMA' };
    value[field] = read as string | number | boolean;
  }
  return { value };
}

/** A base64 or base64url text decoded (line breaks ignored), or undefined if it does not decode cleanly. */
function unbase64(text: string): string | undefined {
  try {
    return atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return undefined;
  }
}

/**
 * Every text an answer could carry the credential in: each field and all
 * string fields joined in order, each as sent, base64 or base64url decoded,
 * and percent-decoded. An arbitrary transform stays out of reach; the
 * credential's own scope bounds that.
 */
function readings(value: ProviderValue): string[] {
  const fields = Object.values(value).map(String);
  const strings = Object.values(value).filter((field) => typeof field === 'string');
  return [...fields, strings.join('')].flatMap((text) => [
    text,
    unbase64(text) ?? '',
    text.replaceAll(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    ),
  ]);
}

/** `work`'s answer, or undefined once `ms` pass first. */
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: Parameters<typeof clearTimeout>[0];
  const late = new Promise<undefined>((done) => {
    timer = setTimeout(done, ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function callConnector(
  registration: OperationRegistration,
  params: Readonly<Record<string, string>>,
  deps: CallDependencies,
): Promise<ConnectorResult> {
  // One deadline for the call: resolving the host spends it as the transport does.
  const { timeoutMs } = registration.connector;
  const started = Date.now();
  const ready = await withinDeadline(prepare(registration, params, deps), timeoutMs);
  const left = timeoutMs - (Date.now() - started);
  const prepared = ready === undefined || left <= 0 ? { refused: 'PROVIDER_TIMEOUT' } : ready;
  if ('refused' in prepared) {
    deps.record(prepared.refused);
    return { kind: 'refused', code: prepared.refused };
  }
  const sent = await prepared.send({ ...prepared.request, timeoutMs: left });
  if (sent.kind === 'refused') {
    deps.record(sent.code);
    return { kind: 'refused', code: sent.code };
  }
  const answered: Read =
    'code' in sent ? { unreadable: sent.code } : readAnswer(registration, sent);
  const { secret } = prepared;
  // A field holding the borrowed credential is the provider echoing it: unreadable, never returned.
  const echoed =
    'value' in answered &&
    secret !== undefined &&
    readings(answered.value).some((text) => text.includes(secret));
  const read: Read = echoed ? ECHOED : answered;
  if ('value' in read) return { kind: 'ok', value: read.value };
  if ('proof' in read) {
    deps.record(read.refused);
    return { kind: 'refused', code: read.refused, proof: read.proof };
  }
  deps.record(read.unreadable);
  // A write whose answer cannot be read may have acted: unknown, never failed.
  return registration.connector.method === 'GET'
    ? { kind: 'refused', code: read.unreadable }
    : { kind: 'unknown', code: read.unreadable };
}
