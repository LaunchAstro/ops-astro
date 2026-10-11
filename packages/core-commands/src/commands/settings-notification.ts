// SPDX-License-Identifier: AGPL-3.0-only
//
// The existing notification setting handler, extracted whole for the settings writer cap.

import { INBOX_REASONS, toldAtOnce } from '../../../core-records/src/index.ts';
import type { InboxReason, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

// The caller's notification setting (INB-1e, CS-2.17). Per channel and never
// per item: the body names no item, and `prepare.ts` refuses one that does.
// In-app is always on, so its one mode is `on` and nothing is stored. The
// email channel and its per-category choice (instant, daily batch, off) is
// MP-2-11's setting (CS-2.17), which the email send reads (AW-07b,
// `email-timing.ts`). Until it lands here, email is declared and not landed.
// Nobody switches off or batches a decision or an incident on any channel,
// and that rule is checked before the channel's own, so it holds the day
// email lands. No setting reaches an item, a gate or an approval.

const CHANNEL_MODES: Readonly<Record<string, readonly string[]>> = {
  in_app: ['on'],
  email: ['instant', 'daily_batch', 'off'],
};

const CATEGORIES: ReadonlySet<string> = new Set(INBOX_REASONS);

const CHANNEL_FIXES: readonly string[] = ['Send channel as in_app or email.'];
const IN_APP_FIXES: readonly string[] = ['In-app is always on. Send mode as on.'];
const CATEGORY_FIXES: readonly string[] = [
  'Send category as one of the inbox reasons, or leave it out for the whole channel.',
];
const NEVER_QUIETED_FIXES: readonly string[] = [
  'Nobody can switch off or batch notifications about a decision or an incident.',
];
const EMAIL_FIXES: readonly string[] = [
  'The email channel is not available yet. Send channel as in_app.',
];
const EMAIL_MODE_FIXES: readonly string[] = ['Send mode as instant, daily_batch or off.'];

/**
 * Validate one channel setting; in-app `on` is the only one that applies
 * today. It reads and writes nothing, so the transaction and caller go unused.
 */
export function setNotificationChannel(
  _tx: TenantQuery,
  _context: CommandContext,
  request: {
    readonly channel: string;
    readonly mode: string;
    readonly category?: string;
  },
): Promise<HandlerOutcome> {
  const modes = CHANNEL_MODES[request.channel];
  const { category } = request;
  let outcome: HandlerOutcome;
  if (modes === undefined) {
    outcome = refused(refuseCommand('FIELD_VALUE_INVALID', ['channel'], CHANNEL_FIXES));
  } else if (category !== undefined && !CATEGORIES.has(category)) {
    outcome = refused(refuseCommand('FIELD_VALUE_INVALID', ['category'], CATEGORY_FIXES));
  } else if (
    category !== undefined &&
    toldAtOnce(category as InboxReason) &&
    request.mode !== 'on' &&
    request.mode !== 'instant'
  ) {
    outcome = refused(refuseCommand('FIELD_VALUE_INVALID', ['category'], NEVER_QUIETED_FIXES));
  } else if (!modes.includes(request.mode)) {
    outcome = refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['mode'],
        request.channel === 'in_app' ? IN_APP_FIXES : EMAIL_MODE_FIXES,
      ),
    );
  } else if (request.channel === 'email') {
    outcome = refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['channel'], EMAIL_FIXES));
  } else {
    outcome = applied(null, null, { channel: request.channel, mode: request.mode });
  }
  return Promise.resolve(outcome);
}
