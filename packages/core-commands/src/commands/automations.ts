// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers (C33, U36; CS-6.9 and roadmap#27's model).
//
// The envelope has already checked the key business-wide and refused every
// agent: `definition.release` is `automation:manage`, `activation.change` is
// `settings:manage`, both `agent: never`. What is left is the value, each
// refused by the field it names without echoing what was sent, then the
// identifiers, where another business's row answers exactly as a fabricated
// one does (row security hides it).
//
// A version is released with the next number, and a racing release is asked
// again inside this transaction: its insert did nothing and the next statement
// sees the winner's row. An activation changes at the revision the caller
// read, compared in the update itself, so two changes at one revision apply
// once. The mode a version permits is checked here for the refusal and again
// by the database's constraint trigger. Changing a mode starts nothing: a run
// needs an occurrence and C52-A's standing approval.
//
// The version's bytes are pinned by the digest and size the caller sends:
// AW-02's pinned read, which would compute them from the bytes, is not on
// this branch (LEANS-ON AW-02).

import {
  changeActivation,
  insertActivation,
  insertDefinition,
  isUuid,
  readActivation,
  readVersion,
  releaseVersion,
  type ActivationMode,
  type ActivationSetting,
  type DefinitionKind,
  type DefinitionVersionRow,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { ActivationChangeRequest, DefinitionReleaseRequest } from './automation-requests.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const MODES: readonly ActivationMode[] = ['manual', 'scheduled', 'event'];
const KINDS: readonly DefinitionKind[] = ['skill', 'automation'];
// The shape `activations_event_shape` holds, and an operation's name alike.
const DOTTED = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
// jsonb and Postgres text refuse a NUL, and jsonb a lone surrogate.
const UNSTORABLE = /[\0\p{Surrogate}]/u;
const RELEASE_ATTEMPTS = 3;

const FIXES: Readonly<Record<string, string>> = {
  mode: 'Send mode as manual, scheduled or event.',
  everyMinutes:
    'Send everyMinutes as a whole number from 1 to 10080 for scheduled, or leave it out.',
  eventKind: 'Send eventKind as a dotted lower-case name, such as invoice.paid, for event only.',
  enabled: 'Send enabled as true or false.',
  expectedRevision: 'Send expectedRevision as the whole number the registry showed.',
  name: 'Send name, 1 to 200 characters, only when releasing a new definition.',
  kind: 'Send kind as skill or automation, only when releasing a new definition.',
  contentDigest: 'Send contentDigest as the 64 lower-case hex digits of the bytes.',
  contentSize: 'Send contentSize as the whole number of bytes, at least 1.',
  inputs: 'Send inputs as a list of up to 50 objects of named string values.',
  operations: 'Send operations as a list of up to 100 distinct dotted operation names.',
  modes: 'Send modes as a list of distinct entries from manual, scheduled and event.',
};

const invalid = (field: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], [FIXES[field] ?? '']));

const notPermitted = (state: string, fix: string): HandlerOutcome =>
  refused(refuseCommand('TRANSITION_NOT_PERMITTED', [state], [fix]));

const absent = (value: unknown): boolean => value === undefined || value === null;

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const isMode = (value: unknown): value is ActivationMode =>
  typeof value === 'string' && (MODES as readonly string[]).includes(value);

type Setting = Omit<ActivationSetting, 'versionId' | 'actorId'>;

/** The activation's values, or the name of the first field that is wrong. */
function settingOf(request: ActivationChangeRequest): Setting | string {
  const { mode, everyMinutes, eventKind, enabled } = request;
  if (!isMode(mode)) return 'mode';
  const scheduled = mode === 'scheduled';
  const everyFits =
    typeof everyMinutes === 'number' &&
    Number.isInteger(everyMinutes) &&
    everyMinutes >= 1 &&
    everyMinutes <= 10_080;
  if (scheduled ? !everyFits : !absent(everyMinutes)) return 'everyMinutes';
  const kindFits = typeof eventKind === 'string' && DOTTED.test(eventKind);
  if (mode === 'event' ? !kindFits : !absent(eventKind)) return 'eventKind';
  if (typeof enabled !== 'boolean') return 'enabled';
  return {
    mode,
    everyMinutes: scheduled ? (everyMinutes as number) : null,
    eventKind: mode === 'event' ? (eventKind as string) : null,
    enabled,
  };
}

export async function changeActivationAsPerson(
  tx: TenantQuery,
  context: CommandContext,
  request: ActivationChangeRequest,
): Promise<HandlerOutcome> {
  const values = settingOf(request);
  if (typeof values === 'string') return invalid(values);
  const changing = request.activationId !== undefined;
  if (changing ? !isRevision(request.expectedRevision) : request.expectedRevision !== undefined) {
    return invalid('expectedRevision');
  }
  if (!isUuid(request.versionId)) return refused(refuseNotFound(['versionId']));
  const version = await readVersion(tx, request.versionId);
  if (version === null) return refused(refuseNotFound(['versionId']));
  if (!version.modes.includes(values.mode)) {
    return notPermitted(`mode=${values.mode}`, 'Choose a mode this version permits.');
  }
  const setting = { ...values, versionId: version.id, actorId: context.session.actorId };
  if (request.activationId === undefined) {
    const created = await insertActivation(tx, setting);
    return created === null ? refused(refuseNotFound(['versionId'])) : appliedActivation(created);
  }
  return await changeExisting(tx, request.activationId, request.expectedRevision as number, {
    version,
    setting,
  });
}

async function changeExisting(
  tx: TenantQuery,
  activationId: string,
  expectedRevision: number,
  to: { readonly version: DefinitionVersionRow; readonly setting: ActivationSetting },
): Promise<HandlerOutcome> {
  if (!isUuid(activationId)) return refused(refuseNotFound(['activationId']));
  // An activation's definition never changes, so reading it unlocked is safe;
  // the update below compares the revision itself.
  const current = await readActivation(tx, activationId);
  if (current === null) return refused(refuseNotFound(['activationId']));
  if (current.definitionId !== to.version.definitionId) {
    return notPermitted('versionId', 'Pin a version of the activation’s own definition.');
  }
  const changed = await changeActivation(tx, activationId, expectedRevision, to.setting);
  if (changed !== null) return appliedActivation(changed);
  const now = await readActivation(tx, activationId);
  return refused(
    refuseCommand(
      'VERSION_STALE',
      [`revision=${now?.revision ?? current.revision}`],
      ['Read the registry again and act on the revision it is at now.'],
    ),
  );
}

const appliedActivation = (row: {
  readonly id: string;
  readonly versionId: string;
  readonly mode: ActivationMode;
  readonly enabled: boolean;
  readonly revision: number;
}): HandlerOutcome =>
  applied(row.id, row.revision, {
    activationId: row.id,
    versionId: row.versionId,
    mode: row.mode,
    enabled: row.enabled,
  });

const storable = (value: unknown): boolean =>
  typeof value === 'string' && value.length <= 200 && !UNSTORABLE.test(value);

function inputsOf(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const fits = value.every(
    (one: unknown) =>
      typeof one === 'object' &&
      one !== null &&
      !Array.isArray(one) &&
      Object.entries(one).every(([key, entry]) => storable(key) && storable(entry)),
  );
  return fits ? value : null;
}

function listOf<T extends string>(
  value: unknown,
  most: number,
  fits: (one: string) => boolean,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > most) return null;
  if (!value.every((one): one is T => typeof one === 'string' && fits(one))) return null;
  return new Set(value).size === value.length ? value : null;
}

type Release = Omit<Parameters<typeof releaseVersion>[1], 'definitionId' | 'actorId'>;

/** The version's values, or the name of the first field that is wrong. */
function releaseOf(request: DefinitionReleaseRequest): Release | string {
  const { contentDigest, contentSize } = request;
  if (typeof contentDigest !== 'string' || !DIGEST.test(contentDigest)) return 'contentDigest';
  if (typeof contentSize !== 'number' || !Number.isSafeInteger(contentSize) || contentSize < 1) {
    return 'contentSize';
  }
  const inputs = inputsOf(request.inputs);
  if (inputs === null) return 'inputs';
  const operations =
    Array.isArray(request.operations) && request.operations.length === 0
      ? []
      : listOf<string>(request.operations, 100, (one) => DOTTED.test(one));
  if (operations === null) return 'operations';
  const modes = listOf<ActivationMode>(request.modes, 3, isMode);
  if (modes === null) return 'modes';
  return { contentDigest, contentSize, inputs, operations, modes };
}

/** A new definition's name and kind, only when no definition is named. */
function newDefinitionOf(
  request: DefinitionReleaseRequest,
): { readonly name: string; readonly kind: DefinitionKind } | string | null {
  if (request.definitionId !== undefined) {
    if (request.name !== undefined) return 'name';
    return request.kind === undefined ? null : 'kind';
  }
  const name = typeof request.name === 'string' ? request.name.trim() : '';
  if (name.length === 0 || !storable(name)) return 'name';
  const { kind } = request;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return 'kind';
  return { name, kind: kind as DefinitionKind };
}

export async function releaseDefinitionVersion(
  tx: TenantQuery,
  context: CommandContext,
  request: DefinitionReleaseRequest,
): Promise<HandlerOutcome> {
  const fresh = newDefinitionOf(request);
  if (typeof fresh === 'string') return invalid(fresh);
  const values = releaseOf(request);
  if (typeof values === 'string') return invalid(values);
  const actorId = context.session.actorId;
  let definitionId = request.definitionId;
  if (fresh !== null) definitionId = await insertDefinition(tx, { ...fresh, actorId });
  if (definitionId === undefined || !isUuid(definitionId)) {
    return refused(refuseNotFound(['definitionId']));
  }
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- a raced release is asked again, in order
    const version = await releaseVersion(tx, { ...values, definitionId, actorId });
    if (version === null) return refused(refuseNotFound(['definitionId']));
    if (version !== 'raced') {
      return applied(version.id, null, {
        definitionId,
        versionId: version.id,
        number: version.number,
      });
    }
  }
  return refused(
    refuseCommand(
      'VERSION_STALE',
      ['definitionId'],
      ['Other versions of this definition were released at the same moment; release again.'],
    ),
  );
}
