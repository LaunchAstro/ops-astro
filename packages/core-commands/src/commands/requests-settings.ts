// SPDX-License-Identifier: AGPL-3.0-only
//
// The existing settings operands, with the priority-stage writer alongside them.

export type SettingsRequest<Envelope> =
  | ({
      readonly command: 'settings.set_four_eyes_threshold';
      /** Null is a real value: the band is off, which the accepted rule permits. */
      readonly value: number | null;
      readonly expectedRevision?: number;
    } & Envelope)
  | ({
      readonly command: 'settings.set_client_sign_off';
      readonly value: boolean;
      readonly expectedRevision?: number;
    } & Envelope)
  | ({
      readonly command: 'settings.set_money_step_up';
      readonly value: boolean;
      readonly expectedRevision?: number;
    } & Envelope)
  // Journey stage ids; an empty list clears them.
  | ({
      readonly command: 'settings.set_priority_stages';
      readonly value: readonly string[];
      readonly expectedRevision?: number;
    } & Envelope)
  // MP-2-11: whole days (C122-1).
  | ({
      readonly command: 'settings.set_conversation_window' | 'settings.set_retention_window';
      readonly value: number;
      readonly expectedRevision?: number;
    } & Envelope);
