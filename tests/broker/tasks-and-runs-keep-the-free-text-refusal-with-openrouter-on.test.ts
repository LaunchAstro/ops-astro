// SPDX-License-Identifier: AGPL-3.0-only
//
// With the OpenRouter route and its paid operation configured, and the
// business's owner on the outside list, a run's step that asks that operation
// with free text is refused as every task call with free text to a cloud
// route is: a refused row, and nothing sent. The carve-out is the
// conversation seam's alone.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { catalogue } from '../../packages/core-connectors/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { broker, call, noDatabase, rowsOf, s, useBrokerWorld } from './broker-world.ts';
import { PAID, PAID_KEY } from './priced-chat-world.ts';

useBrokerWorld('or_task_path');

let work: Work;
beforeAll(async () => {
  if (noDatabase) return;
  work = await liveWork(s, `or-task-path-${randomUUID()}`, 2_000);
}, 180_000);

it.skipIf(noDatabase)(
  "a run's step asking the paid operation with free text is refused, nothing sent",
  async () => {
    let dispatched = 0;
    const withOpenRouter: Broker = {
      ...broker,
      custody: {
        ...broker.custody,
        dispatch: async (...args) => {
          dispatched += 1;
          return await broker.custody.dispatch(...args);
        },
      },
      operations: new Map([...broker.operations, ...catalogue([PAID])]),
      routes: [
        ...broker.routes,
        {
          key: 'openrouter',
          reach: 'cloud',
          provider: 'openrouter',
          credentialRef: 'openrouter',
          credentialKind: 'api_key',
          installation: broker.installation,
          ceiling: 1,
        },
      ],
      outsidePeople: [`${s.business}:${s.decider.personId}`],
    };
    const result = await call(
      work,
      {
        operation: PAID_KEY,
        fields: [{ name: 'message', source: 'outside', value: 'What is due today?' }],
      },
      withOpenRouter,
    );
    expect(result).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(await rowsOf(result.callId)).toMatchObject([{ state: 'refused' }]);
    expect(dispatched).toBe(0);
  },
);
