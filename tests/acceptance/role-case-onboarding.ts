// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix's positive recipes for new client onboarding (C41-A): a client
// record, an onboarding started on one, and a result on its first ready
// step. Each is written through the commands by the caller the context posts
// as; a context that cannot write one gets a fabricated identifier, which the
// recipe survives. Every client takes a name of its own (one name per
// business). Reached from `role-case-positive-body.ts`'s last case, so that
// file stays under the per-file cap.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';
import type { Answer } from './world.ts';

const detailOf = (answer: Answer): Readonly<Record<string, unknown>> =>
  (answer.body['detail'] as Readonly<Record<string, unknown>> | undefined) ?? {};

const clientName = (): string => `a client the matrix onboards ${randomUUID()}`;

async function newClient(context: BodyContext): Promise<string> {
  const made = await context.asPerson('record.create', {
    type: 'client',
    fields: { name: clientName() },
  });
  const id = detailOf(made)['recordId'];
  return typeof id === 'string' ? id : randomUUID();
}

async function readyStep(context: BodyContext): Promise<string> {
  const started = await context.asPerson('onboarding.start', {
    clientId: await newClient(context),
    templateKey: 'standard',
  });
  const steps = detailOf(started)['steps'] as
    readonly { readonly taskId: string; readonly state: string }[] | undefined;
  return steps?.find((one) => one.state === 'ready')?.taskId ?? randomUUID();
}

/** The recipe for an onboarding operation; any other name has no recipe. */
export async function onboardingBody(name: CommandName, context: BodyContext): Promise<Prepared> {
  switch (name) {
    case 'record.create':
      return { body: { type: 'client', fields: { name: clientName() } } };
    case 'onboarding.start':
      return { body: { clientId: await newClient(context), templateKey: 'standard' } };
    case 'onboarding.step_result':
      return {
        body: {
          recordId: await readyStep(context),
          outcome: 'done',
          result: 'the matrix closed it',
        },
      };
    default:
      throw new Error(`matrix: no positive control recipe for ${String(name)}`);
  }
}
