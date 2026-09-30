// SPDX-License-Identifier: AGPL-3.0-only
//
// The request shapes of the caller's own account (C23) and preferences
// (MP-2-11a, MP-2-11), split from `requests.ts` to keep it under the line limit, as
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
  // One guided tip dismissed, merged into the caller's own row (MP-2-11).
  | ({
      readonly command: 'preference.dismiss_tip';
      readonly page: string;
      readonly tip: string;
      readonly version: number;
    } & E);
