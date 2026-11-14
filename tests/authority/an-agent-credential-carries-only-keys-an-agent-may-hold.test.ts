// SPDX-License-Identifier: AGPL-3.0-only
//
// The permission key catalogue (`docs/design-system/CAPABILITY-SLICES.md`)
// says, key by key, whether an agent may hold it. Every agent credential is
// an agent's, so `credential.issue` refuses each key the catalogue marks
// "no", whatever its issuer holds, and nothing is written. The issuer is
// granted each such key first where a grant may carry it, so the refusal is
// the credential's own rule and not `CREDENTIAL_SCOPE_WIDENS`.
//
// And no row an agent credential reaches is authorised on such a key, so a
// credential row holding one could not be used either.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { CREDENTIAL_REACH } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { Action } from '../../packages/core-records/src/index.ts';
import { COMMAND_SURFACE, profileOf } from '../../packages/core-wire/src/index.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { codeOf, credentialsOf, issueAs, issueBody, issuerIn } from './agent-credential-issuer.ts';

const dbIt = serverUrl === undefined ? vitestIt.skip : vitestIt;

/** The catalogue's keys an agent may not hold, as `collection:action`. */
const NO_AGENT: readonly string[] = readFileSync(
  new URL('../../docs/design-system/CAPABILITY-SLICES.md', import.meta.url),
  'utf8',
)
  .split('\n')
  .flatMap((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    const key = /^`([a-z_]+:[a-z]+)`$/u.exec(cells[1] ?? '')?.[1];
    return key !== undefined && cells[3] === 'no' ? [key] : [];
  });

/** The refusals that say a credential never carries a key, whoever issues it. */
const NEVER_CARRIED = new Set(['CREDENTIAL_ACTION_EXCLUDED', 'CREDENTIAL_MONEY_KEY_EXCLUDED']);

let world: World;

beforeAll(async () => {
  if (serverUrl !== undefined) world = await createWorld('credagentkeys');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

vitestIt('the catalogue names keys an agent may not hold', () => {
  expect(NO_AGENT).toEqual(
    expect.arrayContaining([
      'operations:read',
      'conversation:read',
      'chat:comment',
      'account:write',
      'credential:write',
      'task:decide',
    ]),
  );
});

vitestIt('an agent credential reaches no row authorised on a key an agent may not hold', () => {
  const reached = COMMAND_SURFACE.filter((row) => CREDENTIAL_REACH.has(row.name)).flatMap((row) =>
    profileOf(row).authority.map((key) => `${row.name} ${key}`),
  );
  expect(reached.filter((one) => NO_AGENT.includes(one.split(' ')[1] ?? ''))).toEqual([]);
});

dbIt(
  'credential.issue refuses every key an agent may not hold, whatever the issuer holds',
  async () => {
    const issuer = await issuerIn(world);
    const answers: Record<string, unknown> = {};
    for (const key of NO_AGENT) {
      const [collection = '', action = ''] = key.split(':');
      // oxlint-disable-next-line no-await-in-loop -- one grant, then one issue, per key in order
      await world.db.app
        .withBusiness(world.alpha, async (tx) => {
          await grantTo(tx, issuer, action as Action, WHOLE_BUSINESS, false, collection);
        })
        // A key no grant may carry (`account:write`) stays unheld.
        .catch(() => null);
      // oxlint-disable-next-line no-await-in-loop -- one issue per key, in order
      const answer = await issueAs(world, issuer, issueBody({ scope: [{ collection, action }] }));
      answers[key] = isCommandRefusal(answer) ? codeOf(answer) : 'issued';
    }
    const carried = Object.entries(answers).filter(([, code]) => !NEVER_CARRIED.has(String(code)));
    expect(carried, 'keys not refused as never carried').toEqual([]);
    expect(await credentialsOf(world, issuer)).toEqual([]);
  },
  120_000,
);
