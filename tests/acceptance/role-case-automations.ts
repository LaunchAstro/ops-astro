// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix's positive recipes for Settings ▸ Workflow triggers (C33): the
// registry, a release of a new definition, and a manual activation on a
// version the admin has just released. Every row is written through the
// commands, so no hook is needed.
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
    default:
      return undefined;
  }
}
