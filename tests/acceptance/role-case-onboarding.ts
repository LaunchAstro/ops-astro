// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix's positive recipes for new client onboarding (C41-A): a client
// record, an onboarding started on one, and a result on its first ready
// step. Each is written through the commands by the caller the context posts
// as; a context that cannot write one gets a fabricated identifier, which the
// recipe survives.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

export interface OnboardingContext {
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
}

const detailOf = (answer: Answer): Readonly<Record<string, unknown>> =>
  (answer.body['detail'] as Readonly<Record<string, unknown>> | undefined) ?? {};

async function newClient(context: OnboardingContext): Promise<string> {
  const made = await context.asPerson('record.create', {
    type: 'client',
    fields: { name: 'a client the matrix makes' },
  });
  const id = detailOf(made)['recordId'];
  return typeof id === 'string' ? id : randomUUID();
}

async function readyStep(context: OnboardingContext): Promise<string> {
  const started = await context.asPerson('onboarding.start', {
    clientId: await newClient(context),
    templateKey: 'standard',
  });
  const steps = detailOf(started)['steps'] as
    readonly { readonly taskId: string; readonly state: string }[] | undefined;
  return steps?.find((one) => one.state === 'ready')?.taskId ?? randomUUID();
}

/** The recipe for an onboarding operation, or undefined for any other. */
export async function onboardingBody(
  name: CommandName,
  context: OnboardingContext,
): Promise<{ readonly body: Readonly<Record<string, unknown>> } | undefined> {
  switch (name) {
    case 'record.create':
      return { body: { type: 'client', fields: { name: 'the matrix’s client' } } };
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
      return undefined;
  }
}
