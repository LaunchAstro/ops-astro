// SPDX-License-Identifier: AGPL-3.0-only
//
// The operands of setup's writes: custody (C31), the connector fleet
// (MP-14-7a), mandates and graduation (MP-14-10a), automations (C33, C52-A)
// and onboarding (C41-A). Spread into `WRITE_OPERANDS` in `surface.ts`, whose
// type checks every operand; nothing is imported back, so no cycle. Their
// names, with the setup reads', are `SetupCommandName`, part of `CommandName`.

export const SETUP_OPERANDS = {
  // `value` is `any` so a wrong kind is the command's own FIELD_VALUE_INVALID,
  // which names the field and never echoes what was sent.
  'secret.set': { name: 'text', value: 'any', clientId: 'id?|null', expectedRevision: 'any' },
  'secret.clear': { secretId: 'id', expectedRevision: 'any' },
  'connector.repair': { connectionId: 'id', expectedRevision: 'any' },
  // A mandate's classes, ceiling and expiry are checked by value in the
  // command, which names the field it refuses.
  'mandate.file': {
    clientId: 'id',
    classes: 'any',
    refuses: 'any',
    ceiling: 'any',
    expiresAt: 'any',
    label: 'any',
  },
  'mandate.revoke': { mandateId: 'id', expectedRevision: 'any' },
  'graduation.promote': {
    classId: 'id',
    ceiling: 'any',
    expiresAt: 'any',
    expectedRevision: 'any',
  },
  'graduation.demote': { classId: 'id', expectedRevision: 'any' },
  // Every value but the identifiers is checked in the command, which names the
  // field it refuses; a version's modes against the activation's in the database.
  'activation.change': {
    activationId: 'id?',
    versionId: 'id',
    mode: 'any',
    everyMinutes: 'any',
    eventKind: 'any',
    enabled: 'any',
    expectedRevision: 'any',
  },
  'definition.release': {
    definitionId: 'id?',
    name: 'any',
    kind: 'any',
    contentDigest: 'any',
    contentSize: 'any',
    inputs: 'any',
    operations: 'any',
    modes: 'any',
  },
  'activation.adopt': { activationId: 'id', versionId: 'id', expectedRevision: 'any' },
  'activation.roll_back': { activationId: 'id', expectedRevision: 'any' },
  'activation.turn_off': { activationId: 'id', expectedRevision: 'any' },
  'approval.revoke': { approvalId: 'id' },
  // The record type and the step outcome are checked by value in the command.
  'record.create': { type: 'any', fields: 'map' },
  'onboarding.start': { clientId: 'id', templateKey: 'any' },
  'onboarding.step_result': { recordId: 'any', outcome: 'any', result: 'any' },
} as const;

/** Setup's operations, reads and writes: a member of `CommandName`. */
export type SetupCommandName =
  // Custody (C31): the business's secrets, shown only as set or not set. One
  // command serves both secret screens, and no path returns a value.
  | 'secret.list'
  | 'secret.set'
  | 'secret.clear'
  // The connector fleet (MP-14-7a): read by `connection:read`, and a repair
  // started by `custody:manage`, which records it and sends nothing.
  | 'connection.fleet'
  | 'connector.repair'
  // Grants, tripwires and the night round (MP-14-8): one read by
  // `connection:read`, the same page's key. The sections change nothing.
  | 'connection.signal'
  // Graduation and standing mandates (MP-14-10a): the per-client region is one
  // read by `connection:read`; filing, revoking, promoting and demoting are
  // `mandate:manage`, a money key, never an agent's.
  | 'connection.graduation'
  | 'mandate.file'
  | 'mandate.revoke'
  | 'graduation.promote'
  | 'graduation.demote'
  // What agent runs cost (U39): skill costing (MP-14-9) and the agents' cost
  // log (MP-14-6), each one read by `finance:read`, a person's only.
  | 'finance.skill_costs'
  | 'finance.agent_costs'
  // Settings ▸ Workflow triggers (C33): the registry is one read by
  // `settings:read`; changing an activation is `settings:manage` and releasing
  // a definition version `automation:manage`, neither an agent's.
  | 'automation.registry'
  | 'activation.change'
  | 'definition.release'
  // Adoption, rollback, revocation and turning off (C52-A): each
  // `automation:manage`, never an agent's. A rollback is an adoption of the
  // version before; revoking an approval is its own act.
  | 'activation.adopt'
  | 'activation.roll_back'
  | 'activation.turn_off'
  | 'approval.revoke'
  // New client onboarding (C41-A): the record-create command (a client, for
  // now), laying a template out as tasks on that client, and the result each
  // step writes onto its own task.
  | 'record.create'
  | 'onboarding.start'
  | 'onboarding.step_result';
