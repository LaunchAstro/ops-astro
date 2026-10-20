// SPDX-License-Identifier: AGPL-3.0-only
//
// The target-free half of `cd-alternatives.ts` (root ruling 3, ledger I03),
// kept apart for the per-file cap. A harness, not a suite: nothing here runs
// on its own.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';

type Body = Readonly<Record<string, unknown>>;

/**
 * The sixty-three operations that name no identifier, each with a minimal valid body.
 * A positive request moves and shows nothing of bravo's, and a `recordId` aimed at bravo is
 * refused `COMMAND_BODY_INVALID` (SC2, TRANSACTION-CONTRACT line 113, root ruling 3). There is no
 * foreign target to compare with a fabricated one, so their matrix row is "not applicable".
 */
export const TARGET_FREE: readonly (readonly [CommandName, Body])[] = [
  ['task.create', { fields: { title: 'a task made while bravo is watched' } }],
  // WF-2: a chart files a new map and its tickets, naming no existing record.
  ['map.chart', { title: 'a map charted while bravo is watched' }],
  ['task.purge', {}],
  ['settings.set_four_eyes_threshold', { value: 1300 }],
  ['settings.set_client_sign_off', { value: false }],
  ['settings.set_live_correction_approver', { value: null }],
  ['settings.set_money_step_up', { value: true }],
  ['settings.set_single_operator', { value: false }],
  ['settings.set_conversation_window', { value: 14 }],
  ['settings.set_retention_window', { value: 90 }],
  ['settings.set_priority_stages', { value: ['sales'] }],
  [
    'privacy.record_incident',
    {
      whatHappened: 'A made-up incident recorded while bravo is watched.',
      foundAt: new Date(Date.now() - 60_000).toISOString(),
      foundBy: 'The matrix',
      affected: 'Nobody; it is made up.',
      informationKinds: ['other'],
    },
  ],
  ['task.queue', {}],
  ['gate.pending', {}],
  ['task.ledger', { timeZone: 'UTC' }],
  ['person.list', {}],
  ['team.list', {}],
  ['preset.plan', { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] }],
  ['settings.read', {}],
  ['session.capabilities', {}],
  // Custody (C31): the list and a set of a business-wide key name no row.
  ['secret.list', {}],
  ['secret.set', { name: 'target-free.key', value: 'target-free-value' }],
  // Connections (MP-14-7a, MP-14-10a) and agent run costs (MP-14-9, MP-14-6) name no row.
  ['connection.fleet', {}],
  ['connection.signal', {}],
  ['connection.graduation', {}],
  ['finance.skill_costs', {}],
  ['finance.agent_costs', { from: '2026-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' }],
  ['conversation.start', { body: 'a conversation started while bravo is watched' }],
  ['conversation.list', {}],
  // AW-04: a digest names a file's bytes, not a record of any business.
  ['definition.attribution', { digest: 'a'.repeat(64) }],
  // AW-04 (U10): the business's own planning cap, moved once from the default.
  ['budget.set_planning_cap', { limitMinor: 2_000, currency: 'AUD', fromLimitMinor: 5_000 }],
  // A name the vocabulary takes once, so each run makes its own (MP-4-11).
  ['tag.create', { name: `tag ${randomUUID().slice(0, 8)}` }],
  ['tag.list', {}],
  // The reader's own to-dos (MP-7-1).
  ['task.todos', {}],
  ['task.search', { query: 'brochure' }],
  // The maps the reader may read (WF-3): the list names no map.
  ['map.list', {}],
  // The person menu's two (C23): the caller's own account, naming nobody.
  ['session.person', {}],
  ['session.end', {}],
  // The caller's own preferences (MP-2-11a).
  ['preference.read', {}],
  ['preference.save', { preference: 'appearance', value: 'dark' }],
  ['preference.dismiss_tip', { page: 'agency:inbox', tip: 'triage', version: 1 }],
  ['access.read', {}],
  ['operations.read', {}],
  ['client.list', {}],
  ['client.create', { name: 'A made-up client made while bravo is watched' }],
  // The one record-create command (C41-A) names no row; a name of its own each run.
  ['record.create', { type: 'client', fields: { name: `a target-free client ${randomUUID()}` } }],
  [
    'privacy.draft_breach_notices',
    {
      incidentId: '00000000-0000-4000-8000-000000000000',
      oaic: { name: 'A made-up regulator', address: 'regulator@example.test' },
      people: [{ name: 'A made-up person', address: 'person@example.test' }],
      containment: 'Nothing real happened.',
      steps: 'Nothing to do.',
    },
  ],
  [
    'legal.draft_version',
    {
      document: 'breach-runbook',
      version: '9.0',
      body: 'A made-up runbook drafted while bravo is watched.',
    },
  ],
  [
    'privacy.set_overseas_service',
    {
      service: 'A made-up service set while bravo is watched',
      receives: 'nothing real',
      where: 'nowhere',
      trainsOnIt: 'no',
      contract: 'none',
      toConfirm: false,
      inUse: true,
    },
  ],
  [
    'privacy.set_data_class',
    {
      dataClass: 'A made-up class set while bravo is watched',
      purpose: 'nothing real',
      disclosures: 'no one',
      retention: 'a day',
      deletion: 'deleted',
      inUse: true,
    },
  ],
  [
    'credential.issue',
    {
      scope: [{ collection: 'task', action: 'read' }],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      purpose: 'A made-up credential issued while bravo is watched',
    },
  ],
  [
    'operations.record_gate_item',
    { item: 'tested-backups', evidence: 'https://evidence.example/settings/operations/' },
  ],
  ['operations.change_installation_mode', { mode: 'real' }],
  ['inbox.read', {}],
  ['inbox.count', {}],
  ['inbox.unattended', {}],
  ['notifications.set_channel', { channel: 'in_app', mode: 'on' }],
  // The reader's own team conversations (C71-D).
  ['chat.conversations', {}],
  // C39-T: a new invitation names a person and an address, no record.
  ['invitation.create', { name: 'Invited Ivy', email: 'ivy@example.test', role: 'member' }],
  // C39-T: the business's invitations, which names no record.
  ['invitation.list', {}],
  // #1694: the business's corrections the caller reaches, which names no row.
  ['live_correction.list', {}],
  // A client's own reviews, which names no row.
  ['review.client_list', {}],
  // The Reviews page: the business's reviews the caller reads, which names no row.
  ['review.list', {}],
  // The Workflow triggers registry (C33) names no row.
  ['automation.registry', {}],
  // Assign to AI: the caller makes an agent of their own, and lists their own.
  ['agent.create', { name: 'An agent made while bravo is watched' }],
  ['agent.mine', {}],
];
