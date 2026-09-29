// SPDX-License-Identifier: AGPL-3.0-only
//
// One catalogued call to a provider, as the connector definition says and
// nothing the caller adds: the listed host, the declared parameters, no
// redirect followed, the byte cap and deadline, the response checked against
// its schema and filtered to its declared fields. A write whose answer cannot
// be read is unknown, never a success and never a failure: the provider may
// have acted. The credential goes to the provider and nowhere else; no result
// or record carries a provider's words.

import { isIP } from 'node:net';
import type { OperationRegistration } from './catalogue.ts';
import { connectorRelease } from './catalogue.ts';
import { isDeniedAddress, type Resolver, type Transport } from './capture/transport.ts';
import { CONNECTOR_HOSTS } from './site/operations.ts';

export type ProviderValue = Readonly<Record<string, string | number | boolean>>;

export type ProviderResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly code: string; readonly proof?: string }
  | { readonly kind: 'unknown'; readonly code: string };

export type ConnectorResult = ProviderResult<ProviderValue>;

export interface CallDependencies {
  readonly transport: Transport;
  readonly resolve: Resolver;
  /** Borrows the named custody entry for this one call. */
  readonly credential: (entry: 'source_control' | 'hosting') => Promise<string>;
  /** Every refusal and unknown on the path, by code (Receipt L field 14). */
  readonly record: (code: string) => void;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/u;

function validSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== '.' && value !== '..';
}

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
    if (!segments.every(validSegment)) return { code: 'PARAMETER_INVALID' };
    path = path.replace(slot, segments.map(encodeURIComponent).join('/'));
  }
  return { path };
}

function readField(body: unknown, dotted: string): unknown {
  let value: unknown = body;
  for (const part of dotted.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
  }
  return value;
}

export async function callConnector(
  registration: OperationRegistration,
  params: Readonly<Record<string, string>>,
  deps: CallDependencies,
): Promise<ConnectorResult> {
  const { connector, declaration } = registration;
  const write = connector.method !== 'GET';
  const refuse = (code: string, proof?: string): ConnectorResult => {
    deps.record(code);
    return proof === undefined ? { kind: 'refused', code } : { kind: 'refused', code, proof };
  };
  const unreadable = (code: string): ConnectorResult => {
    deps.record(code);
    return write ? { kind: 'unknown', code } : { kind: 'refused', code };
  };

  if (!CONNECTOR_HOSTS.includes(connector.host)) return refuse('DESTINATION_NOT_LISTED');
  if (connectorRelease(connector) !== declaration.connector_release) {
    return refuse('CONNECTOR_RELEASE_UNAVAILABLE');
  }
  const built = buildPath(connector.pathTemplate, params, connector.bodyParams);
  if ('code' in built) return refuse(built.code);

  let address: string;
  try {
    const answers = await deps.resolve(connector.host);
    if (answers.length === 0 || answers.some(isDeniedAddress))
      return refuse('DESTINATION_ADDRESS_DENIED');
    address = answers[0] ?? '';
  } catch {
    return refuse('PROVIDER_UNREACHABLE');
  }

  let token: string | undefined;
  if (connector.credential !== 'none') {
    try {
      token = await deps.credential(connector.credential);
    } catch {
      return refuse('CREDENTIAL_UNAVAILABLE');
    }
  }
  const body = Object.fromEntries(
    connector.bodyParams.flatMap((name) =>
      params[name] === undefined ? [] : [[name, params[name]]],
    ),
  );
  const answer = await deps.transport({
    url: new URL(`https://${connector.host}${built.path}`),
    address,
    family: isIP(address) === 6 ? 6 : 4,
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
  });

  if (answer.kind === 'timeout') return unreadable('PROVIDER_TIMEOUT');
  if (answer.kind === 'oversized') return unreadable('PROVIDER_RESPONSE_OVERSIZED');
  if (answer.kind !== 'answer') return unreadable('PROVIDER_CONNECTION_LOST');
  if (answer.status >= 300 && answer.status < 400) return unreadable('PROVIDER_REDIRECT_REFUSED');
  const proof = connector.refusalProofs[String(answer.status)];
  if (proof !== undefined && declaration.nothing_happened_proof.includes(proof)) {
    return refuse('PROVIDER_REFUSED', proof);
  }
  if (answer.status < 200 || answer.status >= 300) return unreadable('PROVIDER_STATUS_UNEXPECTED');
  const type = (answer.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return unreadable('PROVIDER_RESPONSE_MALFORMED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(answer.body));
  } catch {
    return unreadable('PROVIDER_RESPONSE_MALFORMED');
  }
  const value: Record<string, string | number | boolean> = {};
  for (const [field, kind] of Object.entries(connector.responseSchema)) {
    const read = readField(parsed, field);
    // oxlint-disable-next-line valid-typeof -- `kind` is the schema's own type name
    if (typeof read !== kind) return unreadable('PROVIDER_RESPONSE_SCHEMA');
    value[field] = read as string | number | boolean;
  }
  return { kind: 'ok', value };
}
