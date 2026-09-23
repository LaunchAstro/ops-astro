// SPDX-License-Identifier: AGPL-3.0-only
//
// PICKUP-REPLAY proof group 2: the API process and Postgres both restart
// between the pickup's commit and its retry, with the same persisted key.
//
// Opt-in, because it restarts a database server. It runs only when
// `PICKUP_REPLAY_API_PORT` names a spare loopback port and
// `PICKUP_REPLAY_PG_CONTAINER` names the lane's own container, which must be
// the one `DATABASE_ADMIN_URL` points at. It stops only the PIDs it started.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { LOCAL_KEY_FILE } from '../../packages/core-records/src/authority/credential-keys.ts';
import { BUSINESS_KEY, SECRET } from '../api/fixture.ts';
import {
  detailOf,
  replayWorld,
  type Approver,
  type ReplayWorld,
} from '../commands/pickup-replay-harness.ts';

const serverUrl = databaseUrlFromEnvironment();
const port = process.env['PICKUP_REPLAY_API_PORT'];
const container = process.env['PICKUP_REPLAY_PG_CONTAINER'];
const DENIED = new Set(['8790', '8793', '8797', '8798', '8799', '5190', '5197', '5198', '5199']);
const enabled =
  serverUrl !== undefined &&
  port !== undefined &&
  /^[0-9]{4,5}$/u.test(port) &&
  !DENIED.has(port) &&
  container === 'ops-astro-pickup-replay-pg';

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

interface Running {
  readonly pid: number;
  stop(): Promise<void>;
}

describe.skipIf(!enabled)('a lost pickup across an API and Postgres restart', () => {
  let world: ReplayWorld;
  let approver: Approver;
  const started: number[] = [];

  const health = async (): Promise<boolean> => {
    try {
      return (await fetch(`http://127.0.0.1:${port as string}/api/health`)).status === 200;
    } catch {
      return false;
    }
  };

  async function startApi(): Promise<Running> {
    if (await health()) throw new Error(`something already answers on ${port as string}`);
    const admin = new URL(serverUrl as string);
    admin.pathname = `/${world.fixture.db.name}`;
    const child: ChildProcess = spawn(process.execPath, ['apps/api/server.ts'], {
      env: {
        PATH: process.env['PATH'] ?? '',
        API_PORT: port,
        DATABASE_URL: world.fixture.db.appUrl,
        DATABASE_ADMIN_URL: admin.toString(),
        SUPABASE_JWT_SECRET: SECRET,
        GATE_SIGNING_KEY_ID: world.fixture.environment.GATE_SIGNING_KEY_ID,
        GATE_SIGNING_SECRET: world.fixture.environment.GATE_SIGNING_SECRET,
      },
      stdio: 'ignore',
    });
    const pid = child.pid as number;
    started.push(pid);
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    for (let attempt = 0; attempt < 150; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (exited || (await health())) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
    }
    if (exited || !(await health())) throw new Error('the API process did not answer');
    return {
      pid,
      stop: async () => {
        const gone = new Promise<void>((resolve) => {
          if (exited) resolve();
          else child.once('exit', () => resolve());
        });
        process.kill(pid, 'SIGTERM');
        await gone;
      },
    };
  }

  const overHttp = async (
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const { tokenFor } = await import('../api/fixture.ts');
    const response = await fetch(
      `http://127.0.0.1:${port as string}/api/a/b/${BUSINESS_KEY}${pathOf(name)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor(world.fixture.agent.subject)}`,
          ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
        },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  async function restartPostgres(): Promise<void> {
    const docker = spawnSync('/usr/local/bin/docker', ['restart', container as string], {
      encoding: 'utf8',
    });
    expect(docker.status, docker.stderr).toBe(0);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if ((await world.scalar('select 1::text as v', [])) === '1') return;
      } catch {
        // Not accepting connections yet.
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
    }
    throw new Error('Postgres did not come back');
  }

  beforeAll(async () => {
    world = await replayWorld('prr');
    approver = await world.approver('restart-approver');
  }, 120_000);

  afterAll(async () => {
    for (const pid of started) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await world?.fixture.drop();
  });

  it('replays the same usable credential after both restart, and concurrently', async () => {
    const keyFile = readFileSync(LOCAL_KEY_FILE, 'utf8');
    const { taskId, reservationId } = await world.approved(approver, 'restart_lost');
    const first = await startApi();
    const body = { operationId: randomUUID(), reservationId };
    const lost = await overHttp('task.pickup', body);
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    const credential = String(detailOf(lost as never)['credential']);
    const before = await world.counts(taskId);
    await first.stop();

    await restartPostgres();
    const second = await startApi();
    expect(readFileSync(LOCAL_KEY_FILE, 'utf8')).toBe(keyFile);

    const answers = await Promise.all(
      Array.from({ length: 5 }, async () => await overHttp('task.pickup', body)),
    );
    for (const answer of answers) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(detailOf(answer as never)['credential']).toBe(credential);
      expect(detailOf(answer as never)['leaseId']).toBe(detailOf(lost as never)['leaseId']);
    }
    expect(await world.counts(taskId)).toStrictEqual(before);

    const comment = await overHttp(
      'task.comment',
      {
        operationId: randomUUID(),
        recordId: taskId,
        body: 'after both restarts',
        audience: 'internal',
      },
      credential,
    );
    expect(comment.status, JSON.stringify(comment.body)).toBe(200);
    await second.stop();
  }, 180_000);
});
