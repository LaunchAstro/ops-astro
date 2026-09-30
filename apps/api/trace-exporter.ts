// SPDX-License-Identifier: AGPL-3.0-only
//
// The diagnostic trace export, as the API's composition root turns it on (AW-13).
// Signature only: not built.

import type { Destination } from '../../packages/core-custody/src/index.ts';
import type { TraceDatabase } from '../../packages/core-runtime/src/index.ts';

export const TRACE_PATH = '/api/public/otel/v1/traces';

export type TraceExportSettings =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'on';
      readonly destination: Destination;
      readonly credentialsFile: string;
      readonly key: Buffer;
    }
  | { readonly kind: 'invalid'; readonly problem: string };

export function traceExportSettings(
  _environment: Readonly<Record<string, string | undefined>>,
): TraceExportSettings {
  throw new Error('AW-13 switch: not built');
}

export async function startTraceExporter(
  _settings: Extract<TraceExportSettings, { kind: 'on' }>,
  _database: TraceDatabase,
  _businesses: () => Promise<readonly string[]>,
  _everyMs?: number,
): Promise<{ readonly stop: () => Promise<void> }> {
  await Promise.resolve();
  throw new Error('AW-13 switch: not built');
}
