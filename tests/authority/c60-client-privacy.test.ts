// SPDX-License-Identifier: AGPL-3.0-only
//
// C60 (CS-7.40): a client's privacy settings, stored once on the client record
// and changed by one command, `client.set_privacy`, the tracked action `client
// privacy setting changed (model egress, providers, health, no agent edits)`
// under `privacy:manage`, never an agent's. Model egress is off for a new
// client and goes on only at the client's written request, sent in the same
// command and stored with the change in one transaction (owner line 51). While
// no local-model path exists every cloud provider is refused, request or none,
// and the request is still recorded (owner line 72). A provider with no
// assessed row on the overseas-services register is refused (APP 8.1). The
// "no agent edits" switch (O2) refuses every edit run, through the one check
// the edit run (C77) calls. The world is `c60-client-privacy-world.ts`.

import { describe, expect, it } from 'vitest';
import {
  checkClientEditRun,
  checkClientModelUse,
} from '../../packages/core-records/src/clients/privacy.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  ALL_OFF,
  appliedDetail,
  assess,
  clientRow,
  newClient,
  onAlpha,
  outcome,
  privacyOnAccess,
  request,
  requestsOf,
  setPrivacy,
  useClientsWorld,
} from './c60-client-privacy-world.ts';

useClientsWorld();

const LOCAL_MODEL_WORDS = 'personal information stays out of cloud AI until a local model exists';
const REPLAY_ON = { modelEgress: true, providers: ['replay'] } as const;

async function c60SettingsOnTheClientRecord(): Promise<void> {
  const clientId = await newClient('Settings Clinic');
  expect(await privacyOnAccess(clientId)).toEqual({ clientId, ...ALL_OFF });
  expect(await clientRow(clientId)).toEqual(ALL_OFF);

  const changed = { ...ALL_OFF, handlesHealth: true, noAgentEdits: true };
  appliedDetail(await setPrivacy(clientId, changed), 'health and no agent edits on');
  expect(await clientRow(clientId)).toEqual(changed);
  expect(await privacyOnAccess(clientId)).toEqual({ clientId, ...changed });

  // Health information keeps model egress off: the record refuses both at once.
  const both = await setPrivacy(clientId, { ...changed, ...REPLAY_ON, ...request() });
  expect(outcome(both)).toEqual({ status: 409, code: 'CLIENT_HANDLES_HEALTH' });
  expect(await clientRow(clientId)).toEqual(changed);
}

/** Each way a request can be missing, refused by name with nothing written. */
async function refusedWithoutRequest(clientId: string): Promise<void> {
  for (const missing of [{}, request({ requestedBy: '  ' }), request({ requestLink: '' })]) {
    // oxlint-disable-next-line no-await-in-loop
    const refused = await setPrivacy(clientId, { ...REPLAY_ON, ...missing });
    expect(outcome(refused)).toEqual({ status: 422, code: 'CLIENT_REQUEST_REQUIRED' });
    expect(refused.text).toContain('written request');
  }
  expect(await clientRow(clientId)).toEqual(ALL_OFF);
  expect(await requestsOf(clientId)).toEqual([]);
}

async function c60WrittenRequest(): Promise<void> {
  await assess('replay');
  const clientId = await newClient('Request Clinic');
  await refusedWithoutRequest(clientId);

  appliedDetail(await setPrivacy(clientId, { ...REPLAY_ON, ...request() }), 'with a request');
  expect(await clientRow(clientId)).toEqual({ ...ALL_OFF, ...REPLAY_ON });
  expect(await requestsOf(clientId)).toEqual([
    { ...request(), providers: ['replay'], outcome: 'applied' },
  ]);
  // One transaction: the client row and its request carry the same writer.
  const same = await onAlpha(
    async (tx) =>
      await tx.query<{ readonly same: boolean }>(
        `select (select xmin::text from public.clients where id = $1)
              = (select xmin::text from public.client_model_requests where client_id = $1)
                as same`,
        [clientId],
      ),
  );
  expect(same[0]?.same).toBe(true);
  const use = await onAlpha(async (tx) => await checkClientModelUse(tx, clientId, 'replay'));
  expect(use).toEqual({ ok: true });
}

const CLOUD = [['claude'], ['chatgpt'], ['replay', 'claude']];

async function c60SwitchOnRefusedUntilALocalModel(): Promise<void> {
  await assess('claude');
  await assess('chatgpt');
  const clientId = await newClient('Cloud Clinic');
  for (const providers of CLOUD) {
    // oxlint-disable-next-line no-await-in-loop
    const bare = await setPrivacy(clientId, { modelEgress: true, providers });
    expect(bare.status, `${providers.join()} without a request`).toBeGreaterThanOrEqual(400);
    // oxlint-disable-next-line no-await-in-loop
    const asked = await setPrivacy(clientId, { modelEgress: true, providers, ...request() });
    expect(outcome(asked)).toEqual({ status: 501, code: 'LOCAL_MODEL_REQUIRED' });
    expect(asked.text).toContain(LOCAL_MODEL_WORDS);
  }
  expect(await clientRow(clientId)).toEqual(ALL_OFF);
  const kept = await requestsOf(clientId);
  expect(kept.map((each) => each.providers)).toEqual(CLOUD);
  for (const each of kept) {
    expect(each).toEqual({
      ...request(),
      providers: each.providers,
      outcome: 'LOCAL_MODEL_REQUIRED',
    });
  }
}

async function c60AssessmentRefusal(): Promise<void> {
  const clientId = await newClient('Assessment Clinic');
  // The register's row for the provider, out of use: no assessment stands.
  await assess('replay', false);
  const sent = { ...REPLAY_ON, ...request() };
  const unassessed = await setPrivacy(clientId, sent);
  expect(outcome(unassessed)).toEqual({ status: 409, code: 'PROVIDER_NOT_ASSESSED' });
  expect(unassessed.text).toContain('overseas-services register');
  expect(await clientRow(clientId)).toEqual(ALL_OFF);
  expect(await requestsOf(clientId)).toEqual([
    { ...request(), providers: ['replay'], outcome: 'PROVIDER_NOT_ASSESSED' },
  ]);

  // Assessed, the same request switches it on.
  await assess('replay');
  appliedDetail(await setPrivacy(clientId, sent), 'assessed');
  const use = async () =>
    await onAlpha(async (tx) => await checkClientModelUse(tx, clientId, 'replay'));
  expect(await use()).toEqual({ ok: true });
  // The setting already on refuses client content once the assessment lapses.
  await assess('replay', false);
  expect(await use()).toEqual({ ok: false, code: 'PROVIDER_NOT_ASSESSED' });
  await assess('replay');
  expect(await use()).toEqual({ ok: true });
}

// The case with nothing switched on first: a new client, as the command leaves it.
const EDIT_RUN_CASES = [
  { egress: false, noAgentEdits: false, expected: { ok: false, code: 'CLIENT_MODEL_USE_OFF' } },
  { egress: true, noAgentEdits: false, expected: { ok: true } },
  { egress: true, noAgentEdits: true, expected: { ok: false, code: 'CLIENT_NO_AGENT_EDITS' } },
  { egress: false, noAgentEdits: true, expected: { ok: false, code: 'CLIENT_NO_AGENT_EDITS' } },
];

const editRun = async (clientId: string, provider = 'replay') =>
  await onAlpha(async (tx) => await checkClientEditRun(tx, clientId, provider));

async function c60EditRunCombinations(): Promise<void> {
  await assess('replay');
  for (const { egress, noAgentEdits, expected } of EDIT_RUN_CASES) {
    // oxlint-disable-next-line no-await-in-loop
    const clientId = await newClient('Edit Run Clinic');
    if (egress || noAgentEdits) {
      const settings = egress ? { ...REPLAY_ON, noAgentEdits, ...request() } : { noAgentEdits };
      // oxlint-disable-next-line no-await-in-loop
      appliedDetail(await setPrivacy(clientId, settings), JSON.stringify(settings));
    }
    // oxlint-disable-next-line no-await-in-loop
    const answer = await editRun(clientId);
    expect(answer, `egress ${egress}, no agent edits ${noAgentEdits}`).toEqual(expected);
  }
  // Another provider than the one allowed, and a client of no one's, are refused.
  const allowed = await newClient('Edit Run Other');
  appliedDetail(await setPrivacy(allowed, { ...REPLAY_ON, ...request() }), 'replay on');
  const off = { ok: false, code: 'CLIENT_MODEL_USE_OFF' };
  expect(await editRun(allowed, 'claude')).toEqual(off);
  expect(await editRun('00000000-0000-4000-8000-000000000000')).toEqual(off);
}

const CHANGES = [
  { handlesHealth: true },
  { noAgentEdits: true },
  {},
  { ...REPLAY_ON, ...request() },
  {},
];

const rowsWhere = async (sql: string, parameters: readonly unknown[] = []): Promise<unknown> =>
  await onAlpha(async (tx) => await tx.query(sql, parameters));

async function c60Records(): Promise<void> {
  await assess('replay');
  const clientId = await newClient('Records Clinic');
  for (const settings of CHANGES) {
    // oxlint-disable-next-line no-await-in-loop
    const detail = appliedDetail(await setPrivacy(clientId, settings), JSON.stringify(settings));
    expect(detail).toEqual({ clientId });
  }
  const cloud = await setPrivacy(clientId, {
    modelEgress: true,
    providers: ['claude'],
    ...request(),
  });
  expect(outcome(cloud).code).toBe('LOCAL_MODEL_REQUIRED');
  expect(
    await rowsWhere(
      `select outcome, count(*)::int as n from public.audit_events
        where command = 'client.set_privacy' and subject_record_id = $1
        group by outcome order by outcome`,
      [clientId],
    ),
  ).toEqual([{ outcome: 'applied', n: CHANGES.length }]);
  expect(
    await rowsWhere(`select count(*)::int as n from public.audit_events
      where command = 'client.set_privacy' and outcome = 'refused'`),
  ).not.toEqual([{ n: 0 }]);
  expect(
    await rowsWhere(
      `select count(*)::int as n from public.operations
        where command = 'client.set_privacy' and record_id = $1`,
      [clientId],
    ),
  ).toEqual([{ n: CHANGES.length }]);
  const kept = (await requestsOf(clientId)).map((each) => each.outcome);
  expect(kept).toEqual(['applied', 'LOCAL_MODEL_REQUIRED']);
  expect(await clientRow(clientId)).toEqual(ALL_OFF);
}

describe.skipIf(serverUrl === undefined)('C60 client privacy settings', () => {
  it(
    'C60 settings on the client record: a new client has model use, health and no agent edits off, and a change is stored on its record and shown on Settings ▸ Access',
    c60SettingsOnTheClientRecord,
  );
  it(
    'C60 written request: model egress goes on only with the client written request, stored with the change in one transaction, and is refused without one',
    c60WrittenRequest,
  );
  it(
    'C60 switch-on refused until a local model: every cloud provider is refused with or without a written request, says why in plain words, and writes nothing but the recorded request',
    c60SwitchOnRefusedUntilALocalModel,
  );
  it(
    'C60 assessment refusal: a provider with no assessed row on the overseas-services register is refused client content, and the request is recorded',
    c60AssessmentRefusal,
  );
  it(
    'C60 edit-run combinations: an edit run goes ahead only where model egress allows its provider and no agent edits is off, read through the one check the edit run calls',
    c60EditRunCombinations,
  );
  it(
    'C60 records: every change is tracked with its operation and joins the audit chain, and a refused switch-on is audited with its request kept',
    c60Records,
  );
});
