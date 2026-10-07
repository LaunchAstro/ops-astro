// SPDX-License-Identifier: AGPL-3.0-only
//
// A step task of bravo's (C41-A), for the identifier cases to hand an alpha
// caller: bravo's admin starts an onboarding on bravo's client through
// bravo's own route, and its first step's task is the identifier. Split from
// `ident-audit-cases.ts` to keep that file under the line limit.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer, Caller } from './world.ts';

type Person = (
  caller: Caller,
  name: CommandName,
  body: Readonly<Record<string, unknown>>,
  businessKey?: string,
) => Promise<Answer>;

export async function bravoStepTask(
  person: Person,
  admin: Caller,
  clientId: string,
): Promise<{ readonly stepTaskId: string }> {
  const started = await person(
    admin,
    'onboarding.start',
    { clientId, templateKey: 'standard' },
    'bravo',
  );
  const detail = started.body['detail'] as Readonly<Record<string, unknown>> | undefined;
  const steps = detail?.['steps'] as readonly { readonly taskId: string }[] | undefined;
  const stepTaskId = steps?.[0]?.taskId;
  if (started.code !== 'ok' || stepTaskId === undefined) {
    throw new Error(`ident-audit: bravo’s onboarding.start refused ${started.code}`);
  }
  return { stepTaskId };
}
