// SPDX-License-Identifier: AGPL-3.0-only
//
// What a caller sends. One discriminated union, so a surface cannot grow a
// shape of its own (minimum contract 4.2: "one shape, so that no surface can
// grow its own").
//
// Two things are deliberately *not* in the type.
//
// The actor, the business and the entry point are absent. All three are
// constructed by the server — the first two from trusted authentication, the
// third from which surface the call arrived on — so there is no field here for
// a caller to put them in, which is stronger than validating that they were
// not supplied. The entry point matters as much as the other two: `source` is
// derived from the actor kind and the entry point (ADR 0037:18), so a body
// that could name its own entry point could claim a provenance it does not
// have without ever mentioning `source`.
//
// `expectedRevision` is optional even on the commands that require it. A
// required property would make the refusal unreachable, and
// `EXPECTED_REVISION_REQUIRED` has to be reachable: an HTTP body is untyped,
// the command line parses text, and T1g proves the same refusal on all three
// surfaces. A type that hides a refusal from the surfaces that need to raise
// it is a type protecting the wrong reader.

export type FieldValues = Readonly<Record<string, unknown>>;

interface Envelope {
  /** The repeat-request identity. Required on every command in the surface. */
  readonly operationId: string;
}

interface Targeted extends Envelope {
  readonly recordId: string;
  readonly expectedRevision?: number;
}

export type CommandRequest =
  | ({
      readonly command: 'task.create';
      readonly fields: FieldValues;
      readonly parentId?: string | null;
      readonly board?: string | null;
      readonly boardSection?: string | null;
      readonly stateKey?: string;
    } & Envelope)
  | ({ readonly command: 'task.update'; readonly fields: FieldValues } & Targeted)
  | ({ readonly command: 'task.complete' } & Targeted)
  | ({ readonly command: 'task.reopen'; readonly reason: string } & Targeted)
  | ({ readonly command: 'task.start' } & Targeted)
  | ({
      readonly command: 'task.comment';
      readonly body: string;
      /** `internal` or `client`. Two fields, because who sees it and what it is
       * are two questions (L2 `tasks/comments.ts`). */
      readonly audience: string;
      /** `note`, `client` or `system`. A person writing a comment writes a note. */
      readonly commentType?: string;
    } & Targeted)
  | ({ readonly command: 'task.propose'; readonly gateDefinition: string } & Targeted)
  | ({
      readonly command: 'task.decide';
      readonly gateInstanceId: string;
      readonly proposalVersion: number;
      readonly decision: string;
    } & Envelope)
  | ({ readonly command: 'task.pickup'; readonly recordId: string } & Envelope)
  | ({
      readonly command: 'task.handback';
      readonly recordId: string;
      readonly outcome: string;
    } & Envelope)
  // The owning operations. Each writes the fields its name owns on the field
  // definition, so the payload is the values and nothing else.
  | ({
      readonly command:
        'task.assign' | 'task.triage' | 'task.set_stage' | 'task.set_party' | 'task.set_audience';
      readonly fields: FieldValues;
    } & Targeted)
  | ({ readonly command: 'task.reparent'; readonly parentId: string | null } & Targeted)
  | ({
      readonly command: 'task.move';
      readonly board: string | null;
      readonly boardSection?: string | null;
    } & Targeted)
  | ({
      readonly command: 'task.rank';
      /** Neighbours, never an absolute number (specification 14.2 point 3). */
      readonly afterId?: string | null;
      readonly beforeId?: string | null;
    } & Targeted)
  | ({ readonly command: 'task.trash' } & Targeted)
  | ({ readonly command: 'task.restore'; readonly batchId: string } & Envelope)
  | ({ readonly command: 'task.purge'; readonly olderThanDays: number } & Envelope)
  // The two operation-classified business settings. `value` is the whole
  // payload: the key is the command, not a field, so a caller cannot reach a
  // setting the model classified `generic` through the operation that owns a
  // different one.
  | ({
      readonly command: 'settings.set_four_eyes_threshold';
      /** Null is a real value: the band is off, which the accepted rule permits. */
      readonly value: number | null;
    } & Envelope)
  | ({ readonly command: 'settings.set_client_sign_off'; readonly value: boolean } & Envelope);

/**
 * The part of a request the register compares, which is everything except the
 * identity itself. Two requests differing only in their `operation_id` are two
 * attempts, not a conflict; two differing anywhere else under one identity are
 * the conflict `OPERATION_ID_REUSED` names.
 */
export function comparablePayload(request: CommandRequest): Readonly<Record<string, unknown>> {
  const { operationId: _identity, ...rest } = request;
  return rest;
}
