// SPDX-License-Identifier: AGPL-3.0-only
//
// The invitation commands' request shapes (C39-T), a part of `CommandRequest`
// kept beside it so `requests.ts` stays under the per-file cap. Each is a
// person's act under `access:share`; no agent route reaches any of them.

import type { Envelope } from './request-envelope.ts';

export type AccessRequest =
  | ({
      readonly command: 'invitation.create';
      readonly name: string;
      readonly email: string;
      readonly role: string;
    } & Envelope)
  | ({
      readonly command: 'invitation.resend' | 'invitation.revoke';
      readonly invitationId: string;
    } & Envelope);
