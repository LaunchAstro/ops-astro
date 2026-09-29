// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 skeleton for the red run: signatures only, built in the next commit.

export interface Destination {
  readonly key: string;
  readonly origin: string;
}

export type DestinationRefusal = 'DESTINATION_MALFORMED' | 'DESTINATION_FORBIDDEN';

export function parseDestinations(
  _entries: unknown,
):
  | { readonly ok: true; readonly destinations: ReadonlyMap<string, Destination> }
  | { readonly ok: false; readonly code: DestinationRefusal; readonly at: number } {
  throw new Error('AW-01: not built');
}

export interface OutboundRequest {
  readonly destination: string;
  readonly path: string;
  readonly method: 'POST';
  readonly body: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type OutboundFault =
  'unlisted' | 'bad_path' | 'redirect' | 'timeout' | 'too_large' | 'status' | 'network';

export type Outbound =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly fault: OutboundFault; readonly status: number | null };

export async function send(
  _destinations: ReadonlyMap<string, Destination>,
  _request: OutboundRequest,
  _credential: { readonly header: string; readonly value: string } | null,
): Promise<Outbound> {
  await Promise.resolve();
  throw new Error('AW-01: not built');
}
