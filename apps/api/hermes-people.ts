// SPDX-License-Identifier: AGPL-3.0-only
//
// Hermes Agent's people (#2270), as the API's composition root reads them:
// deployment configuration, not a person's setting. `OPS_HERMES_PEOPLE` is
// `businessId:personId` pairs, comma separated, each two UUIDs. Unset, no one
// is offered Hermes Agent; set, only the carried deployment takes it, with
// exactly one Hermes route (`model-carrier.ts`). A refusal names the
// setting, never its value.

import { PAIR } from './outside-provider.ts';

export const HERMES_PEOPLE_SETTING = 'OPS_HERMES_PEOPLE';

export type HermesPeople =
  | { readonly kind: 'off' }
  | { readonly kind: 'on'; readonly people: readonly string[] }
  | { readonly kind: 'invalid'; readonly problem: string };

/** The setting's pairs in lower case, or why it is refused. */
export function hermesPeopleSetting(
  environment: Readonly<Record<string, string | undefined>>,
): HermesPeople {
  const listed = environment[HERMES_PEOPLE_SETTING] ?? '';
  if (listed === '') return { kind: 'off' };
  const people = listed.split(',').map((pair) => pair.trim().toLowerCase());
  return people.every((pair) => PAIR.test(pair))
    ? { kind: 'on', people }
    : {
        kind: 'invalid',
        problem: `${HERMES_PEOPLE_SETTING} is not a list of businessId:personId pairs`,
      };
}
