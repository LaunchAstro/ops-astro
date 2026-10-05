// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's (C31) and the connector fleet's (MP-14-7a) requests, a member of `CommandRequest`'s union kept beside
// it so `requests.ts` stays one screen of commands, as `requests-tags.ts` is.

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
    } & Envelope);
