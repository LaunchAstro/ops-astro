// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { generateSealingPair, setSecret } from '../../packages/core-records/src/custody/index.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { authorised, post, tokenFor } from '../api/fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { createClient } from '../../packages/core-records/src/clients/clients.ts';
import { GATE_ITEMS } from '../../packages/core-commands/src/commands/first-client-gate.ts';
import { gateRecordBody, legalEvidence } from '../acceptance/role-case-gate-bodies.ts';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const b64 = (text: string) => Buffer.from(text).toString('base64url');

describe('Sol PR 373 round 1 proofs', () => {
  const pair = generateSealingPair('sol/373@1');
  let controls: Controls;
  let pool: Database;
  let headers: Record<string, string>;

  beforeAll(async () => {
    controls = await createControls('sol373', { custody: pair.key });
    pool = connect(controls.fixture.db.appUrl, { max: 4 });
    await controls.fixture.db.app.withBusiness(controls.fixture.business, async (tx) => {
      await grantTo(
        tx,
        controls.manager,
        'manage',
        { kind: 'business', id: null },
        false,
        'custody',
      );
    });
    headers = authorised(await tokenFor(controls.manager.presented.subject));
  });

  afterAll(async () => {
    await pool?.close();
    await controls?.drop();
  });

  it('Sol proof, criterion 5: an insert race must compare expectedRevision against the row the upsert replaces', async () => {
    const inserted = latch();
    const commit = latch();
    const entered = latch();
    let callerPid = 0;
    let completed = false;
    const name = `sol.race-${randomUUID().slice(0, 8)}`;
    const initial = pool.withBusiness(controls.fixture.business, async (tx) => {
      for (const value of ['first-writer-value', 'newest-writer-value']) {
        // eslint-disable-next-line no-await-in-loop -- the second value must replace the first
        await setSecret(tx, {
          name,
          value,
          key: pair.key,
          scope: { kind: 'business', id: null },
          actorId: controls.manager.actorId,
        });
      }
      inserted.release();
      await commit.promise;
    });
    await inserted.promise;
    const database: Database = {
      log: pool.log,
      close: async () => undefined,
      withBusiness: async (business, run) =>
        await pool.withBusiness(business, async (tx) => {
          const [row] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
          callerPid = row?.pid ?? 0;
          entered.release();
          return await run(tx);
        }),
    };
    const api = controls.fixture.compose({ custody: pair.key }, undefined, database);
    const pending = post(
      api,
      '/api/b/alpha/secret/set',
      {
        operationId: randomUUID(),
        name,
        value: 'stale-writer-value',
        expectedRevision: 1,
      },
      headers,
    ).then((answer) => {
      completed = true;
      return answer;
    });
    try {
      await entered.promise;
      let blocked = false;
      const deadline = Date.now() + 5000;
      // eslint-disable-next-line no-unmodified-loop-condition -- the pending request changes completed
      while (!blocked && !completed && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- each poll observes the preceding interval
        const [row] = await controls.fixture.db.admin.execute<{ readonly blocked: boolean }>(
          'select cardinality(pg_blocking_pids($1)) > 0 as blocked',
          [callerPid],
        );
        blocked = row?.blocked === true;
        if (!blocked) {
          // eslint-disable-next-line no-await-in-loop -- wait before polling again
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
      }
      expect(
        blocked || completed,
        'The API setter must either contend with the initial insert or refuse before waiting',
      ).toBe(true);
    } finally {
      commit.release();
      await initial;
    }
    const answer = await pending;
    expect(
      answer.status,
      `Expected VERSION_STALE at revision 2, got ${JSON.stringify(answer.body)}`,
    ).toBe(409);
    expect(answer.body['code']).toBe('VERSION_STALE');
  });

  it('Sol proof, criterion 3: a system field named value must not put secret.set plaintext in audit_events', async () => {
    const fieldId = randomUUID();
    const value = `sol-plaintext-${randomUUID()}`;
    const operationId = randomUUID();
    const { db, business } = controls.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await tx.query(
        `insert into public.field_defs
        (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
         visibility_class, searchable, unique_value, origin)
        select $1, $2, id, 'value', 'Derived value', 'text', null, 'system', 'internal', false, false, 'preset'
        from public.record_types where business_id = $1 and key = 'task'`,
        [business, fieldId],
      );
    });
    try {
      const answer = await post(
        controls.api,
        '/api/b/alpha/secret/set',
        {
          operationId,
          name: 'sol.audit-value',
          value,
        },
        headers,
      );
      // Either an applied set or a field refusal must preserve confidentiality.
      expect([200, 422]).toContain(answer.status);
      const rows = await db.admin.execute<{ readonly attempted: unknown }>(
        'select attempted from public.audit_events where business_id = $1 and operation_id = $2',
        [business, operationId],
      );
      expect(rows).toHaveLength(1);
      expect(
        JSON.stringify(rows),
        'secret.set must keep its value out of the audit payload even on refusal',
      ).not.toContain(value);
    } finally {
      await db.admin.execute('delete from public.field_defs where id = $1', [fieldId]);
    }
  });

  it('Sol proof, criterion 3: whitespace around a ChatGPT encrypted session must not allow custody to store it', async () => {
    const session = [
      b64(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })),
      '',
      b64('nonce'),
      b64('ciphertext'),
      b64('tag'),
    ].join('.');
    const plain = await post(
      controls.api,
      '/api/b/alpha/secret/set',
      {
        operationId: randomUUID(),
        name: 'sol.session-plain',
        value: session,
      },
      headers,
    );
    expect(plain.status).toBe(422);
    const padded = await post(
      controls.api,
      '/api/b/alpha/secret/set',
      {
        operationId: randomUUID(),
        name: 'sol.session-padded',
        value: `\n${session}\n`,
      },
      headers,
    );
    expect(
      padded.status,
      'A pasted session token stays a session token when surrounded by newlines',
    ).toBe(422);
    expect(padded.body['code']).toBe('FIELD_VALUE_INVALID');
  });

  it('Sol proof, criterion 4: a client credential must wait on the first-client gate in real mode', async () => {
    const { db, business } = controls.fixture;
    const client = await db.app.withBusiness(
      business,
      async (tx) =>
        await createClient(tx, 'Sol client credential boundary', controls.manager.actorId),
    );
    if (!client.ok) throw new Error('Proof client was not created');
    const links = await legalEvidence(db.admin, business);
    for (const item of GATE_ITEMS) {
      const body = gateRecordBody(item, links);
      // eslint-disable-next-line no-await-in-loop -- seed the gate items before changing mode
      await db.admin.execute(
        'insert into ops.gate_items (item, evidence, statement) values ($1, $2, $3)',
        [item, body['evidence'], body['statement'] ?? null],
      );
    }
    await db.admin.execute('update ops.installation set operator_business_id = $1', [business]);
    await db.admin.execute("update ops.installation set mode = 'real'");
    await db.admin.execute("delete from ops.gate_items where item = 'phone-alerts'");
    const readiness = await db.admin.execute<{
      readonly mode: string;
      readonly open_items: readonly string[];
    }>('select mode, open_items from public.first_client_readiness()');
    expect(readiness[0]?.mode).toBe('real');
    expect(readiness[0]?.open_items.length).toBeGreaterThan(0);
    const answer = await post(
      controls.api,
      '/api/b/alpha/secret/set',
      {
        operationId: randomUUID(),
        name: 'sol.client-credential',
        value: 'real-client-credential',
        clientId: client.value,
      },
      headers,
    );
    expect(
      answer.status,
      'Client credential intake must be held while the real-data installation has open gate items',
    ).toBe(409);
    expect(answer.body['code']).toBe('GATE_SHUT');
  });
});
