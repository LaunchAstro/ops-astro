// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's requests (C31), a member of `CommandRequest`'s union kept beside
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
    } & Envelope);
