// SPDX-License-Identifier: AGPL-3.0-only
//
// The per-command tables, pinned as they stood at 06ab232.
//
// Written before the command facts were folded into the `COMMAND_SURFACE`
// rows (architecture review d8746a2, candidate 1), and green before and after.
// The tables no longer exist as lists: each is read here off the rows, and the
// agent's two lists are also checked against `agent-envelope.ts`, which still
// keeps its own copy until the agent path reads the rows.
// Five tables are pinned by literal: the runtime-shaped identifier, the
// identifiers each untargeted command takes, the commands that need no
// expected revision, and the agent's two allow-lists. The handler map is
// pinned by what `handleCommand` calls for each write and with which operands,
// so a derivation that sent a command to a different handler, or dropped an
// operand on the way, fails here.
//
// The five untargeted commands that `refuseIrrelevantTarget` never checked
// were pinned as `unchecked` at 06ab232. Architecture observation 2 flipped
// them, red first (`stray-identifiers.test.ts`): each now names the
// identifiers its request type declares, and that change is the one
// deliberate edit to this pin.
//
// This suite moves the database counter by zero, so it is a unit suite and
// must not be named in `tests/db/named-suites.json`.

import { describe, expect, it, vi } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandContext } from '../../packages/core-commands/src/commands/context.ts';
import type { CommandRequest } from '../../packages/core-commands/src/commands/requests.ts';
import {
  COMMAND_SURFACE,
  NEEDS_NO_EXPECTED_REVISION,
  type CommandName,
} from '../../packages/core-wire/src/surface.ts';
import {
  AGENT_SURFACE,
  BEFORE_PICKUP,
} from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { handleCommand } from '../../packages/core-commands/src/commands/handlers.ts';

const calls: { readonly handler: string; readonly operands: readonly unknown[] }[] = [];

/** A stand-in that records its name and every argument after `tx` and `context`. */
function recorder(handler: string) {
  return (_tx: unknown, _context: unknown, ...operands: unknown[]) => {
    calls.push({ handler, operands });
    return Promise.resolve({ kind: 'pinned' });
  };
}

vi.mock('../../packages/core-commands/src/commands/tasks-write.ts', async (original) => ({
  ...(await original<object>()),
  createTask: recorder('createTask'),
  updateTask: recorder('updateTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-state.ts', async (original) => ({
  ...(await original<object>()),
  setState: recorder('setState'),
  writeOwnedFields: recorder('writeOwnedFields'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-place.ts', async (original) => ({
  ...(await original<object>()),
  moveTask: recorder('moveTask'),
  rankTask: recorder('rankTask'),
  reparentTask: recorder('reparentTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-trash.ts', async (original) => ({
  ...(await original<object>()),
  purgeTasks: recorder('purgeTasks'),
  restoreTasks: recorder('restoreTasks'),
  trashTask: recorder('trashTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-comment.ts', async (original) => ({
  ...(await original<object>()),
  commentOnTask: recorder('commentOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/settings-write.ts', async (original) => ({
  ...(await original<object>()),
  setBusinessSetting: recorder('setBusinessSetting'),
  setNotificationChannel: recorder('setNotificationChannel'),
}));
vi.mock('../../packages/core-commands/src/commands/privacy-write.ts', async (original) => ({
  ...(await original<object>()),
  recordIncident: recorder('recordIncident'),
}));
vi.mock('../../packages/core-commands/src/commands/overseas-write.ts', async (original) => ({
  ...(await original<object>()),
  setService: recorder('setService'),
}));
vi.mock('../../packages/core-commands/src/commands/data-class-write.ts', async (original) => ({
  ...(await original<object>()),
  setClass: recorder('setClass'),
}));
vi.mock('../../packages/core-commands/src/commands/credential-write.ts', async (original) => ({
  ...(await original<object>()),
  issueCredential: recorder('issueCredential'),
  revokeCredential: recorder('revokeCredential'),
}));
vi.mock('../../packages/core-commands/src/commands/gate-write.ts', async (original) => ({
  ...(await original<object>()),
  recordGateItem: recorder('recordGateItem'),
  changeInstallationMode: recorder('changeInstallationMode'),
}));
vi.mock('../../packages/core-commands/src/commands/legal-write.ts', async (original) => ({
  ...(await original<object>()),
  draftVersion: recorder('draftVersion'),
  approveVersion: recorder('approveVersion'),
  publishVersion: recorder('publishVersion'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-propose.ts', async (original) => ({
  ...(await original<object>()),
  proposeOnTask: recorder('proposeOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-decide.ts', async (original) => ({
  ...(await original<object>()),
  decideOnGate: recorder('decideOnGate'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-pickup.ts', async (original) => ({
  ...(await original<object>()),
  pickupAsPerson: recorder('pickupAsPerson'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-handback.ts', async (original) => ({
  ...(await original<object>()),
  handbackOwnLease: recorder('handbackOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-lease.ts', async (original) => ({
  ...(await original<object>()),
  heartbeatOwnLease: recorder('heartbeatOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-dispatch.ts', async (original) => ({
  ...(await original<object>()),
  dispatchOwnLease: recorder('dispatchOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-observe.ts', async (original) => ({
  ...(await original<object>()),
  observeOwnLease: recorder('observeOwnLease'),
}));
vi.mock('../../packages/core-commands/src/commands/authority-controls.ts', async (original) => ({
  ...(await original<object>()),
  revokeDelegationAsManager: recorder('revokeDelegationAsManager'),
  revokeGrantAsManager: recorder('revokeGrantAsManager'),
  revokeGrantOnAccess: recorder('revokeGrantOnAccess'),
}));
vi.mock('../../packages/core-commands/src/commands/access-write.ts', async (original) => ({
  ...(await original<object>()),
  createClientRecord: recorder('createClientRecord'),
  grantOnAccess: recorder('grantOnAccess'),
}));
vi.mock('../../packages/core-commands/src/commands/access-end.ts', async (original) => ({
  ...(await original<object>()),
  endAccessOnSettings: recorder('endAccessOnSettings'),
}));
vi.mock('../../packages/core-commands/src/commands/inbox-seen.ts', async (original) => ({
  ...(await original<object>()),
  stampOwnSeen: recorder('stampOwnSeen'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-controls.ts', async (original) => ({
  ...(await original<object>()),
  cancelOnTask: recorder('cancelOnTask'),
  restartOnTask: recorder('restartOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/budget-top-up.ts', async (original) => ({
  ...(await original<object>()),
  topUpOnTask: recorder('topUpOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/budget-record-outcome.ts', async (original) => ({
  ...(await original<object>()),
  recordOutcomeOnTask: recorder('recordOutcomeOnTask'),
}));
vi.mock('../../packages/core-commands/src/commands/budget-write-off.ts', async (original) => ({
  ...(await original<object>()),
  writeOffOnTask: recorder('writeOffOnTask'),
}));

const PINNED_RUNTIME_SHAPED = {
  'task.handback': 'leaseId',
  'task.heartbeat': 'leaseId',
  'task.dispatch': 'leaseId',
  'task.observe': 'leaseId',
  'task.pickup': 'reservationId',
};

const PINNED_UNTARGETED_IDENTIFIERS = {
  'budget.record_outcome': ['recordId', 'attemptId'],
  'budget.top_up': ['recordId'],
  'budget.write_off': ['recordId', 'attemptId'],
  'access.grant': ['holderId', 'clientId'],
  'access.revoke': ['grantId'],
  'access.end': ['holderId'],
  'client.create': [],
  'delegation.revoke': [],
  'credential.issue': [],
  'credential.revoke': ['credentialId'],
  'grant.revoke': [],
  'legal.approve_version': ['versionId'],
  'legal.draft_version': [],
  'legal.publish_version': ['versionId'],
  'operations.change_installation_mode': [],
  'operations.record_gate_item': [],
  'privacy.set_overseas_service': [],
  'privacy.set_data_class': [],
  'privacy.record_incident': [],
  'inbox.seen': ['itemId'],
  'notifications.set_channel': [],
  'settings.set_client_sign_off': [],
  'settings.set_four_eyes_threshold': [],
  'settings.set_money_step_up': [],
  'task.cancel': ['recordId', 'lineageId'],
  'task.create': ['parentId', 'board', 'boardSection'],
  'task.decide': ['gateId', 'versionId'],
  'task.handback': ['leaseId'],
  'task.heartbeat': ['leaseId'],
  'task.dispatch': ['leaseId'],
  'task.observe': ['leaseId', 'attemptId'],
  'task.pickup': ['reservationId'],
  'task.purge': [],
  'task.restart': ['recordId', 'lineageId'],
  'task.restore': ['batchId'],
};

const PINNED_NEEDS_NO_EXPECTED_REVISION = [
  'access.end',
  'access.grant',
  'access.read',
  'access.revoke',
  'budget.record_outcome',
  'budget.top_up',
  'budget.write_off',
  'client.create',
  'client.list',
  'credential.issue',
  'credential.revoke',
  'delegation.revoke',
  'grant.revoke',
  'inbox.count',
  'inbox.read',
  'inbox.seen',
  'inbox.unattended',
  'legal.approve_version',
  'legal.draft_version',
  'legal.publish_version',
  'notifications.set_channel',
  'operations.change_installation_mode',
  'operations.read',
  'operations.record_gate_item',
  'person.list',
  'preset.plan',
  'privacy.draft_breach_notices',
  'privacy.record_incident',
  'privacy.set_data_class',
  'privacy.set_overseas_service',
  'session.capabilities',
  'settings.read',
  'settings.set_client_sign_off',
  'settings.set_four_eyes_threshold',
  'settings.set_money_step_up',
  'task.board',
  'task.cancel',
  'task.create',
  'task.decide',
  'task.dispatch',
  'task.execution',
  'task.handback',
  'task.heartbeat',
  'task.observe',
  'task.pickup',
  'task.purge',
  'task.queue',
  'task.read',
  'task.receipt',
  'task.restart',
  'task.restore',
];

const PINNED_AGENT_SURFACE = [
  'session.capabilities',
  'task.comment',
  'task.decide',
  'task.dispatch',
  'task.handback',
  'task.heartbeat',
  'task.observe',
  'task.pickup',
  'task.propose',
  'task.queue',
  'task.read',
];

const PINNED_BEFORE_PICKUP = ['task.pickup', 'task.queue'];

/** One request per write, each operand a distinct value so a dropped or swapped one shows. */
const REQUESTS: readonly CommandRequest[] = [
  { command: 'task.create', operationId: 'op', fields: { title: 'f-create' } },
  { command: 'task.update', operationId: 'op', recordId: 'r', fields: { title: 'f-update' } },
  { command: 'task.complete', operationId: 'op', recordId: 'r' },
  { command: 'task.reopen', operationId: 'op', recordId: 'r', reason: 'why-reopen' },
  {
    command: 'task.comment',
    operationId: 'op',
    recordId: 'r',
    body: 'b-comment',
    audience: 'a-comment',
    commentType: 't-comment',
    mentions: 'm-comment',
  },
  {
    command: 'task.propose',
    operationId: 'op',
    recordId: 'r',
    purpose: 'p-propose',
    maximumMinor: 1,
    currency: 'AUD',
    payload: {},
    step: { kind: 'k', payload: {} },
  },
  {
    command: 'task.decide',
    operationId: 'op',
    gateId: 'g',
    versionId: 'v',
    decision: 'approve',
    note: 'n',
  },
  { command: 'task.pickup', operationId: 'op', reservationId: 'res' },
  { command: 'task.handback', operationId: 'op', leaseId: 'l', fence: 2, outcome: 'done' },
  { command: 'task.start', operationId: 'op', recordId: 'r' },
  { command: 'task.assign', operationId: 'op', recordId: 'r', fields: { assignee: 'f-assign' } },
  { command: 'task.triage', operationId: 'op', recordId: 'r', fields: { intake: 'f-triage' } },
  { command: 'task.set_stage', operationId: 'op', recordId: 'r', fields: { stage: 'f-stage' } },
  { command: 'task.set_party', operationId: 'op', recordId: 'r', fields: { party: 'f-party' } },
  {
    command: 'task.set_audience',
    operationId: 'op',
    recordId: 'r',
    fields: { audience: 'f-audience' },
  },
  { command: 'task.reparent', operationId: 'op', recordId: 'r', parentId: 'parent' },
  { command: 'task.move', operationId: 'op', recordId: 'r', board: 'b', boardSection: 's' },
  { command: 'task.rank', operationId: 'op', recordId: 'r', afterId: 'after' },
  { command: 'task.trash', operationId: 'op', recordId: 'r' },
  { command: 'task.restore', operationId: 'op', batchId: 'batch' },
  { command: 'task.purge', operationId: 'op', olderThanDays: 9 },
  {
    command: 'settings.set_four_eyes_threshold',
    operationId: 'op',
    value: 5000,
    expectedRevision: 3,
  },
  { command: 'settings.set_client_sign_off', operationId: 'op', value: true },
  { command: 'settings.set_money_step_up', operationId: 'op', value: false },
  {
    command: 'privacy.record_incident',
    operationId: 'op',
    whatHappened: 'w',
    foundAt: 'f',
    foundBy: 'b',
    affected: 'a',
    informationKinds: ['other'],
  },
  { command: 'legal.draft_version', operationId: 'op', document: 'd', version: 'v', body: 'b' },
  { command: 'legal.approve_version', operationId: 'op', versionId: 'version', digest: 'x' },
  { command: 'legal.publish_version', operationId: 'op', versionId: 'version' },
  {
    command: 'privacy.set_overseas_service',
    operationId: 'op',
    service: 's',
    receives: 'r',
    where: 'w',
    trainsOnIt: 't',
    contract: 'c',
    toConfirm: false,
    inUse: true,
  },
  {
    command: 'privacy.set_data_class',
    operationId: 'op',
    dataClass: 'd',
    purpose: 'p',
    disclosures: 'd',
    retention: 'r',
    deletion: 'd',
    inUse: true,
  },
  {
    command: 'credential.issue',
    operationId: 'op',
    scope: [{ collection: 'task', action: 'read' }],
    expiresAt: 'e',
    purpose: 'p',
  },
  { command: 'credential.revoke', operationId: 'op', credentialId: 'credential' },
  { command: 'operations.record_gate_item', operationId: 'op', item: 'i', evidence: 'e' },
  { command: 'operations.change_installation_mode', operationId: 'op', mode: 'm' },
  { command: 'client.create', operationId: 'op', name: 'n' },
  {
    command: 'access.grant',
    operationId: 'op',
    holderId: 'person',
    collection: 'task',
    action: 'read',
    clientId: null,
  },
  { command: 'access.revoke', operationId: 'op', grantId: 'grant' },
  { command: 'access.end', operationId: 'op', holderId: 'person' },
  { command: 'grant.revoke', operationId: 'op', grantId: 'grant' },
  { command: 'delegation.revoke', operationId: 'op', delegationId: 'delegation' },
  { command: 'task.cancel', operationId: 'op', recordId: 'r', lineageId: 'lin', reason: 'stop' },
  { command: 'task.restart', operationId: 'op', recordId: 'r', lineageId: 'lin' },
  { command: 'task.heartbeat', operationId: 'op', leaseId: 'l', fence: 4 },
  { command: 'task.dispatch', operationId: 'op', leaseId: 'l', fence: 4 },
  { command: 'task.observe', operationId: 'op', leaseId: 'l', fence: 4, attemptId: 'at' },
  {
    command: 'budget.top_up',
    operationId: 'op',
    recordId: 'r',
    amountMinor: 7,
    fromMaximumMinor: 8,
  },
  {
    command: 'budget.record_outcome',
    operationId: 'op',
    recordId: 'r',
    attemptId: 'at',
    outcome: 'happened',
  },
  {
    command: 'budget.write_off',
    operationId: 'op',
    recordId: 'r',
    attemptId: 'at',
    amountMinor: 0,
    reason: 'why',
  },
  { command: 'inbox.seen', operationId: 'op', itemId: 'item' },
  { command: 'notifications.set_channel', operationId: 'op', channel: 'in_app', mode: 'on' },
];

/** Where each request went: `[handler, ...what it was handed after tx and context]`. */
const PINNED_HANDLERS: Readonly<Record<string, readonly unknown[]>> = {
  'task.create': ['createTask', 'request'],
  'task.update': ['updateTask', 'request'],
  'task.complete': ['setState', 'completed'],
  'task.reopen': ['setState', 'unstarted', 'why-reopen'],
  'task.comment': ['commentOnTask', 'op', 'b-comment', 'a-comment', 't-comment', 'm-comment'],
  'task.propose': ['proposeOnTask', 'request'],
  'task.decide': ['decideOnGate', 'request'],
  'task.pickup': ['pickupAsPerson', 'request'],
  'task.handback': ['handbackOwnLease', 'request'],
  'task.start': ['setState', 'started'],
  'task.assign': ['writeOwnedFields', 'task.assign', { assignee: 'f-assign' }],
  'task.triage': ['writeOwnedFields', 'task.triage', { intake: 'f-triage' }],
  'task.set_stage': ['writeOwnedFields', 'task.set_stage', { stage: 'f-stage' }],
  'task.set_party': ['writeOwnedFields', 'task.set_party', { party: 'f-party' }],
  'task.set_audience': ['writeOwnedFields', 'task.set_audience', { audience: 'f-audience' }],
  'task.reparent': ['reparentTask', 'parent'],
  'task.move': ['moveTask', 'b', 's'],
  'task.rank': ['rankTask', 'after', null],
  'task.trash': ['trashTask'],
  'task.restore': ['restoreTasks', 'batch'],
  'task.purge': ['purgeTasks', 9],
  'settings.set_four_eyes_threshold': [
    'setBusinessSetting',
    'settings.set_four_eyes_threshold',
    5000,
    3,
  ],
  'settings.set_client_sign_off': [
    'setBusinessSetting',
    'settings.set_client_sign_off',
    true,
    undefined,
  ],
  'settings.set_money_step_up': [
    'setBusinessSetting',
    'settings.set_money_step_up',
    false,
    undefined,
  ],
  'privacy.record_incident': ['recordIncident', 'request'],
  'legal.draft_version': ['draftVersion', 'request'],
  'legal.approve_version': ['approveVersion', 'request'],
  'legal.publish_version': ['publishVersion', 'request'],
  'privacy.set_overseas_service': ['setService', 'request'],
  'privacy.set_data_class': ['setClass', 'request'],
  'credential.issue': ['issueCredential', 'request'],
  'credential.revoke': ['revokeCredential', 'request'],
  'operations.record_gate_item': ['recordGateItem', 'request'],
  'operations.change_installation_mode': ['changeInstallationMode', 'request'],
  'client.create': ['createClientRecord', 'request'],
  'access.grant': ['grantOnAccess', 'request'],
  'access.revoke': ['revokeGrantOnAccess', 'grant'],
  'access.end': ['endAccessOnSettings', 'request'],
  'grant.revoke': ['revokeGrantAsManager', 'grant'],
  'delegation.revoke': ['revokeDelegationAsManager', 'delegation'],
  'task.cancel': ['cancelOnTask', 'request'],
  'task.restart': ['restartOnTask', 'request'],
  'task.heartbeat': ['heartbeatOwnLease', 'request'],
  'task.dispatch': ['dispatchOwnLease', 'request'],
  'task.observe': ['observeOwnLease', 'request'],
  'budget.top_up': ['topUpOnTask', 'request'],
  'budget.record_outcome': ['recordOutcomeOnTask', 'request'],
  'budget.write_off': ['writeOffOnTask', 'request'],
  'inbox.seen': ['stampOwnSeen', 'item'],
  'notifications.set_channel': ['setNotificationChannel', 'request'],
};

const untargetedWrites = COMMAND_SURFACE.filter(
  (command) => command.kind === 'write' && !command.targetsExistingRecord,
).map((command) => command.name);

/** One fact off every row that states it, by command name. */
function view<T>(fact: (row: (typeof COMMAND_SURFACE)[number]) => T | undefined) {
  return Object.fromEntries(
    COMMAND_SURFACE.flatMap((row) => {
      const value = fact(row);
      return value === undefined ? [] : [[row.name, value]];
    }),
  );
}

const RUNTIME_SHAPED = view((row) => row.runtimeShaped);
const UNTARGETED_IDENTIFIERS = view((row) => row.untargetedIdentifiers);
const agentReach = (reach: readonly string[]) =>
  COMMAND_SURFACE.filter((row) => reach.includes(row.agent))
    .map((row) => row.name)
    .toSorted();

describe('the per-command tables at 06ab232', () => {
  it('shapes the same runtime identifier for the same three commands', () => {
    expect({ ...RUNTIME_SHAPED }).toStrictEqual(PINNED_RUNTIME_SHAPED);
  });

  it('checks the declared identifiers on every untargeted write', () => {
    const table: Readonly<Record<string, unknown>> = UNTARGETED_IDENTIFIERS;
    expect(
      Object.keys(table).filter((name) => !untargetedWrites.includes(name as CommandName)),
    ).toStrictEqual([]);
    const seen = Object.fromEntries(
      untargetedWrites.map((name) => [name, table[name] ?? 'unchecked']),
    );
    expect(seen).toStrictEqual(PINNED_UNTARGETED_IDENTIFIERS);
  });

  it('exempts the same forty-nine from an expected revision', () => {
    expect([...NEEDS_NO_EXPECTED_REVISION].toSorted()).toStrictEqual(
      PINNED_NEEDS_NO_EXPECTED_REVISION,
    );
  });

  it('lets an agent reach the same eleven, two of them before a pickup', () => {
    expect(agentReach(['delegated', 'before-pickup'])).toStrictEqual(PINNED_AGENT_SURFACE);
    expect(agentReach(['before-pickup'])).toStrictEqual(PINNED_BEFORE_PICKUP);
    expect([...AGENT_SURFACE].toSorted()).toStrictEqual(PINNED_AGENT_SURFACE);
    expect([...BEFORE_PICKUP].toSorted()).toStrictEqual(PINNED_BEFORE_PICKUP);
  });
});

describe('the per-command requests and handlers at 06ab232', () => {
  it('pins a request for every write in the surface', () => {
    const writes = COMMAND_SURFACE.filter((command) => command.kind === 'write').map(
      (command) => command.name,
    );
    expect(REQUESTS.map((request) => request.command).toSorted()).toStrictEqual(writes.toSorted());
    expect(Object.keys(PINNED_HANDLERS).toSorted()).toStrictEqual(writes.toSorted());
  });
});

describe('the per-command tables at 06ab232', () => {
  it.each(REQUESTS.map((request) => [request.command, request] as const))(
    'hands %s to the same handler with the same operands',
    async (name, request) => {
      calls.length = 0;
      const tx = {} as TenantQuery;
      const context = {} as CommandContext;
      await handleCommand(tx, context, request);
      expect(calls).toHaveLength(1);
      const [call] = calls;
      const operands = call?.operands.map((operand) => (operand === request ? 'request' : operand));
      expect([call?.handler, ...(operands ?? [])]).toStrictEqual(PINNED_HANDLERS[name]);
    },
  );
});
