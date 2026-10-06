// SPDX-License-Identifier: AGPL-3.0-only
//
// The invitation commands' request shapes (C39-T), a part of `CommandRequest`
// through `requests-privacy.ts`, kept apart so each file stays under the
// per-file cap. Each is a person's act under `access:share`; no agent route
// reaches any of them. `E` is the envelope, passed in as that file's is.

export type AccessRequest<E> =
  | ({
      readonly command: 'invitation.create';
      readonly name: string;
      readonly email: string;
      readonly role: string;
    } & E)
  | ({
      readonly command: 'invitation.resend' | 'invitation.revoke';
      readonly invitationId: string;
    } & E);
