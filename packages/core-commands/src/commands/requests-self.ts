// SPDX-License-Identifier: AGPL-3.0-only
//
// The request shapes of the caller's own account (C23), preferences
// (MP-2-11a, MP-2-11), inbox item (INB-1d) and notification setting (INB-1e),
// split from `requests.ts` to keep it under the line limit, as
// `requests-privacy.ts` is. `E` is that file's envelope, passed in.

export type SelfRequest<E> =
  // Sign-out names nothing: the account is the caller's (C23).
  | ({ readonly command: 'session.end' } & E)
  // A key of the caller's own preference row (MP-2-11a).
  | ({
      readonly command: 'preference.save';
      readonly preference: string;
      readonly value: unknown;
    } & E)
  // The recipient opening their own inbox item (INB-1d).
  | ({ readonly command: 'inbox.seen'; readonly itemId: string } & E)
  // The caller's own notification setting on one channel (INB-1e).
  | ({
      readonly command: 'notifications.set_channel';
      readonly channel: string;
      readonly mode: string;
      readonly category?: string;
    } & E)
  // One guided tip dismissed, merged into the caller's own row (MP-2-11).
  | ({
      readonly command: 'preference.dismiss_tip';
      readonly page: string;
      readonly tip: string;
      readonly version: number;
    } & E);
