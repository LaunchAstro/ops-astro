// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix's positive recipes for Settings ▸ Workflow triggers (C33): the
// registry, a release of a new definition, and a manual activation on a
// version the admin has just released; and for its standing approvals (C52-A):
// an activation pinning version 1 of two, adopted, rolled back, revoked or
// turned off. Every row is written through the commands, so no hook is needed.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

export interface AutomationsContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
}

const RELEASE = {
  name: 'the matrix releases an automation',
  kind: 'automation',
  contentDigest: 'd'.repeat(64),
  contentSize: 1,
  inputs: [],
  operations: [],
  modes: ['manual'],
} as const;

/** A version to pin: one the admin releases, or a fabricated id where it cannot. */
async function releasedVersion(context: AutomationsContext): Promise<string> {
  const released = await context.asPerson('definition.release', RELEASE);
  const detail = released.body['detail'] as Readonly<Record<string, unknown>> | undefined;
  return typeof detail?.['versionId'] === 'string' ? detail['versionId'] : randomUUID();
}

const detailOf = (answer: Answer): Readonly<Record<string, unknown>> =>
  (answer.body['detail'] as Readonly<Record<string, unknown>> | undefined) ?? {};

const idOf = (answer: Answer, field: string): string => {
  const value = detailOf(answer)[field];
  return typeof value === 'string' ? value : randomUUID();
};

/** An enabled manual activation pinning version 1 of a definition with two versions. */
async function pinnedFirst(
  context: AutomationsContext,
): Promise<{ readonly activationId: string; readonly second: string }> {
  const released = await context.asPerson('definition.release', RELEASE);
  const on = await context.asPerson('activation.change', {
    versionId: idOf(released, 'versionId'),
    mode: 'manual',
    enabled: true,
  });
  const { name: _name, kind: _kind, ...again } = RELEASE;
  const next = await context.asPerson('definition.release', {
    ...again,
    definitionId: idOf(released, 'definitionId'),
  });
  return { activationId: idOf(on, 'activationId'), second: idOf(next, 'versionId') };
}

/** Version 2 adopted on the activation, at revision 2. */
async function adopted(
  context: AutomationsContext,
): Promise<{ readonly activationId: string; readonly approvalId: string }> {
  const { activationId, second } = await pinnedFirst(context);
  const adopt = await context.asPerson('activation.adopt', {
    activationId,
    versionId: second,
    expectedRevision: 1,
  });
  return { activationId, approvalId: idOf(adopt, 'approvalId') };
}

async function approvalsBody(
  name: CommandName,
  context: AutomationsContext,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  switch (name) {
    case 'activation.adopt': {
      const { activationId, second } = await pinnedFirst(context);
      return { activationId, versionId: second, expectedRevision: 1 };
    }
    case 'activation.roll_back':
      return { activationId: (await adopted(context)).activationId, expectedRevision: 2 };
    case 'activation.turn_off':
      return { activationId: (await pinnedFirst(context)).activationId, expectedRevision: 1 };
    case 'approval.revoke':
      return { approvalId: (await adopted(context)).approvalId };
    default:
      return undefined;
  }
}

/** The recipe for a Workflow triggers operation, or undefined for any other. */
export async function automationsBody(
  name: CommandName,
  context: AutomationsContext,
): Promise<{ readonly body: Readonly<Record<string, unknown>> } | undefined> {
  switch (name) {
    case 'automation.registry':
      return { body: {} };
    case 'definition.release':
      return { body: RELEASE };
    case 'activation.change':
      return {
        body: { versionId: await releasedVersion(context), mode: 'manual', enabled: false },
      };
    default: {
      const body = await approvalsBody(name, context);
      return body === undefined ? undefined : { body };
    }
  }
}
