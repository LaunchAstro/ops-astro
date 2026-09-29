// SPDX-License-Identifier: AGPL-3.0-only
import type { AlertKind, Where } from './catalogue.ts';
export interface Frame {
  readonly filename: string;
  readonly function: string;
  readonly lineno: number;
  readonly in_app: true;
}
export interface SinkEvent {
  readonly event_id: string;
  readonly timestamp: number;
  readonly platform: 'node';
  readonly level: 'error' | 'warning';
  readonly environment: Where;
  readonly release?: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly message?: { readonly formatted: string };
  readonly exception?: {
    readonly values: readonly {
      readonly type: string;
      readonly value: string;
      readonly stacktrace: { readonly frames: readonly Frame[] };
    }[];
  };
}
export type Transport = (event: SinkEvent) => Promise<void>;
export interface Place {
  readonly where: Where;
  readonly release?: string;
  readonly root: string;
}
export interface Alerts {
  readonly fault: (cause: unknown) => Promise<void>;
  readonly settled: () => Promise<void>;
}
export function errorEvent(_cause: unknown, _place: Place): SinkEvent {
  throw new Error('S0-2: not built');
}
export function alertEvent(_kind: AlertKind, _where: Where, _release?: string): SinkEvent {
  throw new Error('S0-2: not built');
}
export function dsnTransport(_dsn: string, _fetcher: typeof fetch = fetch): Transport {
  throw new Error('S0-2: not built');
}
export function createAlerts(_options: Place & { readonly send: Transport }): Alerts {
  throw new Error('S0-2: not built');
}
