// SPDX-License-Identifier: AGPL-3.0-only
export type Where = 'staging' | 'production';
export type AlertKind =
  | 'web-down'
  | 'api-down'
  | 'sink-down'
  | 'backup-silent'
  | 'app-error'
  | 'test'
  | 'sign-in-failures'
  | 'authority-changed'
  | 'secret-scan-failed'
  | 'cross-scope-burst'
  | 'webhook-signature-failures'
  | 'export-volume';
export const ALERT_KINDS: readonly AlertKind[] = [];
export interface PlainAlert {
  readonly title: string;
  readonly text: string;
}
export function plainAlert(_kind: AlertKind, _where: Where): PlainAlert {
  throw new Error('S0-2: not built');
}
