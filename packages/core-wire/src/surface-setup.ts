// SPDX-License-Identifier: AGPL-3.0-only
//
// The operands of setup's writes: custody (C31), the connector fleet
// (MP-14-7a), mandates and graduation (MP-14-10a), automations (C33, C52-A)
// and onboarding (C41-A). Spread into `WRITE_OPERANDS` in `surface.ts`, whose
// type checks every operand; nothing is imported back, so no cycle.

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
