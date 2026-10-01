// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's, the connector fleet's and graduation's requests (C31, MP-14-7a,
// MP-14-10a), a member of `CommandRequest`'s union kept beside it so
// `requests.ts` stays one screen of commands, as `requests-onboarding.ts` is.

export type ConnectionsRequest<Envelope> =
  // Custody (C31). `value` and `expectedRevision` are checked by value in the
  // handler, which names the field and never echoes what was sent.
  | ({
      readonly command: 'secret.set';
      readonly name: string;
      readonly value: unknown;
      readonly clientId?: string | null;
      readonly expectedRevision?: unknown;
    } & Envelope)
  | ({
      readonly command: 'secret.clear';
      readonly secretId: string;
      readonly expectedRevision?: unknown;
    } & Envelope)
  // The connector fleet (MP-14-7a): start a repair of one broken connection.
  | ({
      readonly command: 'connector.repair';
      readonly connectionId: string;
      readonly expectedRevision?: unknown;
    } & Envelope)
  // Graduation and standing mandates (MP-14-10a): each value is checked in the
  // command, which names the field it refuses.
  | ({
      readonly command: 'mandate.file';
      readonly clientId: string;
      readonly classes?: unknown;
      readonly refuses?: unknown;
      readonly ceiling?: unknown;
      readonly expiresAt?: unknown;
      readonly label?: unknown;
    } & Envelope)
  | ({
      readonly command: 'mandate.revoke';
      readonly mandateId: string;
      readonly expectedRevision?: unknown;
    } & Envelope)
  | ({
      readonly command: 'graduation.promote';
      readonly classId: string;
      readonly ceiling?: unknown;
      readonly expiresAt?: unknown;
      readonly expectedRevision?: unknown;
    } & Envelope)
  | ({
      readonly command: 'graduation.demote';
      readonly classId: string;
      readonly expectedRevision?: unknown;
    } & Envelope);
