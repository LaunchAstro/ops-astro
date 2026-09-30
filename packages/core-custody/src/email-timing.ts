// SPDX-License-Identifier: AGPL-3.0-only
//
// When an inbox item is emailed (AW-07b): stubbed so its cases run red first.

import type {
  BusinessId,
  Database,
  InboxReason,
  TenantQuery,
} from '../../core-records/src/index.ts';
import type { Broker } from './broker-types.ts';
import type { EmailResult, MailSettings } from './broker-email.ts';

export type EmailChoice = 'instant' | 'daily_batch' | 'off';

export interface EmailPreferences {
  readonly mock: boolean;
  choice(tx: TenantQuery, personId: string, reason: InboxReason): Promise<EmailChoice>;
}

export interface EmailTiming {
  readonly broker: Broker;
  readonly mail: MailSettings;
  readonly preferences: EmailPreferences;
}

export type BatchResult =
  | { readonly ok: true; readonly items: number; readonly attemptIds: readonly string[] }
  | { readonly ok: false; readonly code: 'NOTHING_WAITING' | 'BATCH_ALREADY_SENT' }
  | { readonly ok: false; readonly code: 'EMAIL_FAILED'; readonly fault: string };

export function emailAtOnce(
  _database: Database,
  _businessId: BusinessId,
  _itemId: string,
  _timing: EmailTiming,
): Promise<EmailResult | { readonly ok: false; readonly code: 'NOT_AT_ONCE' }> {
  return Promise.resolve({ ok: false, code: 'NOT_AT_ONCE' });
}

export function emailDailyBatch(
  _database: Database,
  _businessId: BusinessId,
  _personId: string,
  _timing: EmailTiming,
): Promise<BatchResult> {
  return Promise.resolve({ ok: false, code: 'NOTHING_WAITING' });
}
