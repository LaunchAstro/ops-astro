// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix's positive recipes for Connections & signal: the fleet and a
// repair (MP-14-7a), grants and the night round (MP-14-8), and graduation and
// standing mandates (MP-14-10a). Their rows are owner-written, because what
// writes them (the connector setup, the broker, the agent loops) is not built;
// a context that cannot write one leaves the hook out and the body names a
// fabricated identifier, which the recipe survives.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

export interface ConnectionsContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  /** A broken connection to repair (MP-14-7a). */
  brokenConnection?(): Promise<string>;
  /** A graduation row that clears the bar, and its client (MP-14-10a). */
  readyClass?(): Promise<{ readonly classId: string; readonly clientId: string }>;
}

const LIMITS = (): Readonly<Record<string, unknown>> => ({
  ceiling: { amountMinor: 100, currency: 'AUD' },
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

async function readyClassOf(
  context: ConnectionsContext,
): Promise<{ readonly classId: string; readonly clientId: string }> {
  return (await context.readyClass?.()) ?? { classId: randomUUID(), clientId: randomUUID() };
}

async function mandateBody(
  context: ConnectionsContext,
): Promise<Readonly<Record<string, unknown>>> {
  const { clientId } = await readyClassOf(context);
  return { clientId, classes: ['*'], ...LIMITS(), label: 'the matrix files a mandate' };
}

/** A mandate to revoke: one the admin files, or a fabricated id where it cannot. */
async function filedMandate(context: ConnectionsContext): Promise<string> {
  const filed = await context.asPerson('mandate.file', await mandateBody(context));
  const detail = filed.body['detail'] as Readonly<Record<string, unknown>> | undefined;
  return typeof detail?.['mandateId'] === 'string' ? detail['mandateId'] : randomUUID();
}

/** The recipe for a Connections & signal operation, or undefined for any other. */
export async function connectionsBody(
  name: CommandName,
  context: ConnectionsContext,
): Promise<{ readonly body: Readonly<Record<string, unknown>> } | undefined> {
  switch (name) {
    case 'connection.fleet':
    case 'connection.signal':
    case 'connection.graduation':
      return { body: {} };
    case 'connector.repair':
      return { body: { connectionId: (await context.brokenConnection?.()) ?? randomUUID() } };
    case 'mandate.file':
      return { body: await mandateBody(context) };
    case 'mandate.revoke':
      return { body: { mandateId: await filedMandate(context) } };
    case 'graduation.promote':
      return { body: { classId: (await readyClassOf(context)).classId, ...LIMITS() } };
    case 'graduation.demote': {
      const { classId } = await readyClassOf(context);
      await context.asPerson('graduation.promote', { classId, ...LIMITS() });
      return { body: { classId } };
    }
    default:
      return undefined;
  }
}
