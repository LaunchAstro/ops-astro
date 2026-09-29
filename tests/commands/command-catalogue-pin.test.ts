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
}));
vi.mock('../../packages/core-commands/src/commands/custody-secrets.ts', async (original) => ({
  ...(await original<object>()),
  setCustodySecret: recorder('setCustodySecret'),
  clearCustodySecret: recorder('clearCustodySecret'),
}));
vi.mock('../../packages/core-commands/src/commands/connector-repair.ts', async (original) => ({
  ...(await original<object>()),
  startConnectorRepair: recorder('startConnectorRepair'),
}));
vi.mock('../../packages/core-commands/src/commands/mandates.ts', async (original) => ({
  ...(await original<object>()),
  fileMandate: recorder('fileMandate'),
  revokeStandingMandate: recorder('revokeStandingMandate'),
  promoteClass: recorder('promoteClass'),
  demoteClass: recorder('demoteClass'),
}));
vi.mock('../../packages/core-commands/src/commands/automations.ts', async (original) => ({
  ...(await original<object>()),
  changeActivationAsPerson: recorder('changeActivationAsPerson'),
  releaseDefinitionVersion: recorder('releaseDefinitionVersion'),
}));
vi.mock('../../packages/core-commands/src/commands/automation-approvals.ts', async (original) => ({
  ...(await original<object>()),
  adoptActivationVersion: recorder('adoptActivationVersion'),
  rollBackActivation: recorder('rollBackActivation'),
  turnOffActivationAsPerson: recorder('turnOffActivationAsPerson'),
  revokeStandingApproval: recorder('revokeStandingApproval'),
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
vi.mock('../../packages/core-commands/src/commands/authority-controls.ts', async (original) => ({
  ...(await original<object>()),
  revokeDelegationAsManager: recorder('revokeDelegationAsManager'),
  revokeGrantAsManager: recorder('revokeGrantAsManager'),
}));
vi.mock('../../packages/core-commands/src/commands/tasks-controls.ts', async (original) => ({
  ...(await original<object>()),
  cancelOnTask: recorder('cancelOnTask'),
  restartOnTask: recorder('restartOnTask'),
}));

const PINNED_RUNTIME_SHAPED = {
  'task.handback': 'leaseId',
  'task.heartbeat': 'leaseId',
  'task.pickup': 'reservationId',
};

const PINNED_UNTARGETED_IDENTIFIERS = {
  'activation.adopt': ['activationId', 'versionId'],
  'activation.change': ['activationId', 'versionId'],
  'activation.roll_back': ['activationId'],
  'activation.turn_off': ['activationId'],
  'approval.revoke': ['approvalId'],
  'connector.repair': ['connectionId'],
  'definition.release': ['definitionId'],
  'delegation.revoke': [],
  'graduation.demote': ['classId'],
  'graduation.promote': ['classId'],
  'grant.revoke': [],
  'mandate.file': ['clientId'],
  'mandate.revoke': ['mandateId'],
  'secret.clear': ['secretId'],
  'secret.set': ['clientId'],
  'settings.set_client_sign_off': [],
  'settings.set_four_eyes_threshold': [],
  'task.cancel': ['recordId', 'lineageId'],
  'task.create': ['parentId', 'board', 'boardSection'],
  'task.decide': ['gateId', 'versionId'],
  'task.handback': ['leaseId'],
  'task.heartbeat': ['leaseId'],
  'task.pickup': ['reservationId'],
  'task.purge': [],
  'task.restart': ['recordId', 'lineageId'],
  'task.restore': ['batchId'],
};

const PINNED_NEEDS_NO_EXPECTED_REVISION = [
  'activation.adopt',
  'activation.change',
  'activation.roll_back',
  'activation.turn_off',
  'approval.revoke',
  'automation.registry',
  'connection.fleet',
  'connection.graduation',
  'connection.signal',
  'connector.repair',
  'definition.release',
  'delegation.revoke',
  'graduation.demote',
  'graduation.promote',
  'grant.revoke',
  'mandate.file',
  'mandate.revoke',
  'person.list',
  'preset.plan',
  'secret.clear',
  'secret.list',
  'secret.set',
  'session.capabilities',
  'settings.read',
  'settings.set_client_sign_off',
  'settings.set_four_eyes_threshold',
  'task.board',
  'task.cancel',
  'task.create',
  'task.decide',
  'task.handback',
  'task.heartbeat',
  'task.pickup',
  'task.purge',
  'task.queue',
  'task.read',
  'task.restart',
  'task.restore',
];

const PINNED_AGENT_SURFACE = [
  'session.capabilities',
  'task.comment',
  'task.decide',
  'task.handback',
  'task.heartbeat',
  'task.pickup',
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
  { command: 'secret.set', operationId: 'op', name: 'n', value: 'v' },
  { command: 'secret.clear', operationId: 'op', secretId: 's' },
  { command: 'connector.repair', operationId: 'op', connectionId: 'c' },
  { command: 'mandate.file', operationId: 'op', clientId: 'c' },
  { command: 'mandate.revoke', operationId: 'op', mandateId: 'm' },
  { command: 'graduation.promote', operationId: 'op', classId: 'g' },
  { command: 'graduation.demote', operationId: 'op', classId: 'g' },
  { command: 'activation.change', operationId: 'op', versionId: 'v' },
  { command: 'definition.release', operationId: 'op' },
  { command: 'activation.adopt', operationId: 'op', activationId: 'a', versionId: 'v' },
  { command: 'activation.roll_back', operationId: 'op', activationId: 'a' },
  { command: 'activation.turn_off', operationId: 'op', activationId: 'a' },
  { command: 'approval.revoke', operationId: 'op', approvalId: 'p' },
  { command: 'grant.revoke', operationId: 'op', grantId: 'grant' },
  { command: 'delegation.revoke', operationId: 'op', delegationId: 'delegation' },
  { command: 'task.cancel', operationId: 'op', recordId: 'r', lineageId: 'lin', reason: 'stop' },
  { command: 'task.restart', operationId: 'op', recordId: 'r', lineageId: 'lin' },
  { command: 'task.heartbeat', operationId: 'op', leaseId: 'l', fence: 4 },
];

/** Where each request went: `[handler, ...what it was handed after tx and context]`. */
const PINNED_HANDLERS: Readonly<Record<string, readonly unknown[]>> = {
  'task.create': ['createTask', 'request'],
  'task.update': ['updateTask', 'request'],
  'task.complete': ['setState', 'completed'],
  'task.reopen': ['setState', 'unstarted', 'why-reopen'],
  'task.comment': ['commentOnTask', 'b-comment', 'a-comment', 't-comment'],
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
  'secret.set': ['setCustodySecret', 'request'],
  'secret.clear': ['clearCustodySecret', 'request'],
  'connector.repair': ['startConnectorRepair', 'request'],
  'mandate.file': ['fileMandate', 'request'],
  'mandate.revoke': ['revokeStandingMandate', 'request'],
  'graduation.promote': ['promoteClass', 'request'],
  'graduation.demote': ['demoteClass', 'request'],
  'activation.change': ['changeActivationAsPerson', 'request'],
  'definition.release': ['releaseDefinitionVersion', 'request'],
  'activation.adopt': ['adoptActivationVersion', 'request'],
  'activation.roll_back': ['rollBackActivation', 'request'],
  'activation.turn_off': ['turnOffActivationAsPerson', 'request'],
  'approval.revoke': ['revokeStandingApproval', 'request'],
  'grant.revoke': ['revokeGrantAsManager', 'grant'],
  'delegation.revoke': ['revokeDelegationAsManager', 'delegation'],
  'task.cancel': ['cancelOnTask', 'request'],
  'task.restart': ['restartOnTask', 'request'],
  'task.heartbeat': ['heartbeatOwnLease', 'request'],
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

  it('exempts the same thirty-eight from an expected revision', () => {
    expect([...NEEDS_NO_EXPECTED_REVISION].toSorted()).toStrictEqual(
      PINNED_NEEDS_NO_EXPECTED_REVISION,
    );
  });

  it('lets an agent reach the same eight, two of them before a pickup', () => {
    expect(agentReach(['delegated', 'before-pickup'])).toStrictEqual(PINNED_AGENT_SURFACE);
    expect(agentReach(['before-pickup'])).toStrictEqual(PINNED_BEFORE_PICKUP);
    expect([...AGENT_SURFACE].toSorted()).toStrictEqual(PINNED_AGENT_SURFACE);
    expect([...BEFORE_PICKUP].toSorted()).toStrictEqual(PINNED_BEFORE_PICKUP);
  });

  it('pins a request for every write in the surface', () => {
    const writes = COMMAND_SURFACE.filter((command) => command.kind === 'write').map(
      (command) => command.name,
    );
    expect(REQUESTS.map((request) => request.command).toSorted()).toStrictEqual(writes.toSorted());
    expect(Object.keys(PINNED_HANDLERS).toSorted()).toStrictEqual(writes.toSorted());
  });

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
