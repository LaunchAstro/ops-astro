// SPDX-License-Identifier: AGPL-3.0-only
//
// The live correction's provider calls carried by custody, so the caller's
// process never holds a site token. Custody's destination for each site entry
// is derived from the connector catalogue: exactly the catalogued calls that
// use that entry, each as its fixed template (`routeTemplate`) with its
// catalogued response schema as the fields custody keeps, no POST beside
// them, and the headers the guarded call would send. Custody passes back only
// those fields, or withholds the answer whole when the caller could rebuild
// the credential from them. A call catalogued later is admitted with no
// second list. The port hands each guarded call to custody by its entry's name, with
// no header of the caller's. This file runs in the caller's process, never in
// custody's.

import {
  SITE_OPERATIONS,
  SLOT_SEGMENTS,
  type CallDependencies,
  type CredentialReference,
  type CustodyAnswer,
  type OperationRegistration,
} from '../../core-connectors/src/index.ts';
import type { Custody } from './custody.ts';
import type { Destination } from './egress.ts';
import type { TemplateRoute } from './egress-routes.ts';

/**
 * The route a call to this registration takes, as a fixed template custody
 * holds: a fixed-shape slot spelled as its segments, and a read's declared
 * parameters, every one required, as its query in the order the call writes it.
 */
export function routeTemplate({ connector }: OperationRegistration): string {
  const path = connector.pathTemplate.replaceAll(/\{([a-z]+)\*\}/gu, (slot, name: string) => {
    const fixed = SLOT_SEGMENTS.get(name);
    return fixed === undefined ? slot : Array.from({ length: fixed }, () => `{${name}}`).join('/');
  });
  const query =
    connector.method === 'GET' ? connector.bodyParams.map((name) => `${name}={${name}}`) : [];
  if (query.length === 0) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query.join('&')}`;
}

/** Custody's destination for one site entry, keyed by the entry's own name. */
export function siteDestination(
  entry: CredentialReference['ref'],
  origin: string,
  registrations: readonly OperationRegistration[] = SITE_OPERATIONS,
): Destination {
  const routes = new Map<string, TemplateRoute>();
  for (const registration of registrations) {
    const { method, credential } = registration.connector;
    if (credential !== entry || method === 'PATCH') continue;
    const template = routeTemplate(registration);
    const fields = registration.connector.responseSchema;
    routes.set(`${method} ${template}`, { method, template, fields });
  }
  return {
    key: entry,
    origin,
    headers: { accept: 'application/json', 'user-agent': 'site-connector' },
    routes: [...routes.values()],
    post: false,
  };
}

const EMPTY = new Uint8Array();
const WITHHELD = {
  echoed: 'PROVIDER_CREDENTIAL_ECHOED',
  malformed: 'PROVIDER_RESPONSE_MALFORMED',
} as const;

/** The guarded call's custody port: a referenced call dispatched to the entry's own destination. */
export function siteCustody(
  custody: Pick<Custody, 'dispatch'>,
): NonNullable<CallDependencies['custody']> {
  return async (request, { ref }): Promise<CustodyAnswer> => {
    const method = request.method ?? 'GET';
    if (method === 'PATCH') return { kind: 'refused', code: 'CUSTODY_REQUEST_MALFORMED' };
    const outcome = await custody.dispatch(ref, {
      destination: ref,
      path: `${request.url.pathname}${request.url.search}`,
      method,
      body: request.body === undefined ? '' : new TextDecoder().decode(request.body),
      timeoutMs: request.timeoutMs,
      maxResponseBytes: request.maxBytes,
    });
    if (outcome.kind === 'refused') return { kind: 'refused', code: outcome.code };
    // Custody lost mid-call may have sent it: unreadable, so a write stays unknown.
    if (outcome.kind === 'worker_lost') return { kind: 'failed' };
    // Withheld after sending: unreadable, so a write stays unknown.
    if (outcome.kind === 'withheld') return { kind: 'withheld', code: WITHHELD[outcome.reason] };
    const { outbound } = outcome;
    if (outbound.ok) {
      const body = new TextEncoder().encode(outbound.body);
      const { mediaType } = outbound;
      const headers = mediaType === undefined ? {} : { 'content-type': mediaType };
      return { kind: 'answer', status: outbound.status, headers, body };
    }
    switch (outbound.fault) {
      case 'unlisted':
      case 'bad_path':
        return { kind: 'refused', code: 'CUSTODY_ROUTE_REFUSED' };
      case 'forbidden':
        return { kind: 'refused', code: 'DESTINATION_ADDRESS_DENIED' };
      // A gated send past its deadline wrote nothing; a site call is never gated.
      case 'lapsed':
        return { kind: 'refused', code: 'SEND_LAPSED' };
      case 'redirect':
      case 'status':
        return { kind: 'answer', status: outbound.status ?? 0, headers: {}, body: EMPTY };
      case 'timeout':
        return { kind: 'timeout' };
      case 'too_large':
        return { kind: 'oversized' };
      case 'network':
        return { kind: 'failed' };
    }
  };
}
