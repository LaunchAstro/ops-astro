// SPDX-License-Identifier: AGPL-3.0-only
//
// #970: production's acts (the web deploy's Vercel calls, the promotion's
// pointing and starting) run through `authorisedAct` (operator.ts): the
// person's `operations:manage` grant rows held, and the gate asked again under
// that hold before the act begins. A gate admitted earlier is not enough: once
// the grant is revoked, the login's mapping ended, or the login remapped to
// another person, the act is refused and never begun.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authorisedAct } from '../../scripts/ops/authorised-act.ts';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import {
  operatorOnlyHooks,
  person,
  serverUrl,
  subjects,
  type OperatorOnlyState,
} from './operator-only.fixture.ts';
import { signedIn } from './s0-3e-operating-business.fixture.ts';

const admitted = async () => {
  const { env } = await signedIn(subjects.operator, 'alpha');
  const gate = await requireOperatingOperator(env);
  if (!gate.ok) throw new Error(gate.reason);
  return gate;
};
/** Refused with `work` never begun. */
const refusedUnbegun = async (gate: Awaited<ReturnType<typeof admitted>>) => {
  const work = vi.fn(() => Promise.resolve('ran'));
  await expect(authorisedAct(gate, work)).rejects.toThrow(/no longer holds operations:manage/u);
  expect(work).not.toHaveBeenCalled();
};

/** The operator's own login, as the gate resolves it. */
const operatorLogin = async (state: OperatorOnlyState): Promise<string> => {
  const rows = await state.db.admin.execute<{ login_id: string }>(
    'select login_id from public.person_logins where person_id = $1',
    [state.operatorPerson],
  );
  return rows[0]!.login_id;
};

// Without a database the fixture has nothing to build, as in operator-only-acts.test.ts.
describe.skipIf(serverUrl === undefined)(
  'an operator acts only under a held grant, asked again',
  () => {
    let state: OperatorOnlyState;
    operatorOnlyHooks((shared) => {
      state = shared;
    });

    it('an unchanged gate runs the act', async () => {
      const gate = await admitted();
      await expect(authorisedAct(gate, () => Promise.resolve('ran'))).resolves.toBe('ran');
    });

    it('a login remapped to another person holding the key refuses the act', async () => {
      const gate = await admitted();
      const login = await operatorLogin(state);
      let other = '';
      await state.db.app.withBusiness(state.alphaBusiness, async (tx) => {
        other = await person(tx, 'Pat', `pt-${randomUUID()}`, { scope: 'business' });
      });
      const remap = 'update public.person_logins set person_id = $1 where login_id = $2';
      await state.db.admin.execute(remap, [other, login]);
      try {
        await refusedUnbegun(gate);
      } finally {
        await state.db.admin.execute(remap, [state.operatorPerson, login]);
      }
    });

    it('a login whose mapping has ended refuses the act', async () => {
      const gate = await admitted();
      const login = await operatorLogin(state);
      const ended =
        'update public.person_logins set active = $1, deactivated_at = $2 where login_id = $3';
      await state.db.admin.execute(ended, [false, new Date(), login]);
      try {
        await refusedUnbegun(gate);
      } finally {
        await state.db.admin.execute(ended, [true, null, login]);
      }
    });

    // Last: the revocation is not undone.
    it('a grant revoked since admission refuses the act', async () => {
      const gate = await admitted();
      await state.db.admin.execute(
        "update public.grants set revoked_at = now() where subject_id = $1 and collection = 'operations' and action = 'manage'",
        [state.operatorPerson],
      );
      await refusedUnbegun(gate);
    });
  },
);
