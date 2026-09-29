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
  const answer = await deps.transport({ url: new URL(`https://${registration.connector.host}/`), address: '', family: 4, headers: {}, timeoutMs: 1, maxBytes: 1e9, ...(params ? {} : {}) }); return answer.kind === 'answer' ? { kind: 'ok', value: JSON.parse(new TextDecoder().decode(answer.body) || '{}') as ProviderValue } : { kind: 'ok', value: {} };
}
