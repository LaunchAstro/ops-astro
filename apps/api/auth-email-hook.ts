// SPDX-License-Identifier: AGPL-3.0-only
// Stub for the red run (C39-T P2): the route exists and does nothing yet.

import type { Hono } from 'hono';
import type { Broker, MailSettings } from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';

export const AUTH_EMAIL_HOOK_PATH = '/api/hooks/auth-email';

export type AuthEmailHookSettings =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly problem: string }
  | { readonly kind: 'configured'; readonly secret: string };

export function authEmailHookSettings(
  _environment: Readonly<Record<string, string | undefined>>,
): AuthEmailHookSettings {
  return { kind: 'absent' };
}

export interface AuthEmailHookOptions {
  readonly secret: string;
  readonly businesses: () => Promise<readonly BusinessId[]>;
  readonly broker: Broker;
  readonly mail: MailSettings;
  readonly now?: () => number;
}

export function mountAuthEmailHook(
  server: Hono,
  _database: Database,
  _options: AuthEmailHookOptions,
): void {
  server.post(AUTH_EMAIL_HOOK_PATH, (context) => context.json({ code: 'NOT_BUILT' }, 501));
}
