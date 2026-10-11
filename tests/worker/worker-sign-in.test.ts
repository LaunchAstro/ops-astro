// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker keeps its own sign-in (owner ruling, 11 October 2026; the staging
// worker went dead an hour after it started). It signs in with the agent's
// email and password, renews the bearer before it runs out, and once more when
// the API answers `AUTH_SESSION_EXPIRED`, sending the same call under the same
// operation id. A worker the API keeps refusing its credentials exits 1 with
// one line naming the setting, never its value. Work it holds from one pass to
// the next keeps its lease alive with `task.heartbeat`. The API and the
// sign-in service here are fakes; nothing leaves the process.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transport } from '../../apps/cli/client.ts';
import { main } from '../../apps/worker/main.ts';
import { agentSignIn } from '../../apps/worker/sign-in.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../packages/core-wire/src/index.ts';
import { streamText } from '../support/console-text.ts';
import { SIGN_IN_SETTINGS } from '../support/stand-in-gotrue.ts';

const PASSWORD = SIGN_IN_SETTINGS.OPS_ASTRO_PASSWORD;
const DELEGATION = 'delegation-canary-0b7e';
const HEARTBEAT = 'https://heartbeat.example.test/api/push/made-up-worker-token';
const SETTINGS = {
  OPS_ASTRO_BUSINESS: 'alpha',
  ...SIGN_IN_SETTINGS,
  OPS_ASTRO_DELEGATION: DELEGATION,
  OPS_ASTRO_WORKER_INTERVAL_MS: '0',
  OPS_WORKER_HEARTBEAT_URL: HEARTBEAT,
  OPS_EGRESS_HEARTBEAT_HOST: 'heartbeat.example.test',
};
const PROPOSING: readonly CommandName[] = ['session.capabilities', 'task.read', 'task.propose'];

interface Sent {
  readonly verb: string;
  readonly body: Record<string, unknown>;
  readonly bearer: string;
}

/** The verb a path posts, for the proposal's three; any other path as it is. */
const verbOf = (path: string): string =>
  PROPOSING.find((verb) => path.endsWith(pathOf(verb))) ?? path;

const refusal = (code: string): Response =>
  Response.json({ refused: true, code, names: [], fixes: [] }, { status: 401 });

/** A proposal's ordinary answers. */
function proposing(verb: string): Response {
  if (verb === 'session.capabilities') {
    return Response.json({ agentActorId: 'agent-1', purposeScope: { id: 'task-1' } });
  }
  if (verb === 'task.read') return Response.json({ detail: { task: { revision: 1 } } });
  return Response.json({ detail: { version: 1, gateId: 'gate-1' } });
}

/** GoTrue's password grant, each sign-in its own numbered bearer. */
function gotrue(life = 3_600) {
  const issued: string[] = [];
  const fetch = ((): Promise<Response> => {
    issued.push(`bearer-canary-${issued.length + 1}`);
    return Promise.resolve(Response.json({ access_token: issued.at(-1), expires_in: life }));
  }) as typeof globalThis.fetch;
  return { issued, fetch };
}

/** Everything written to stdout and stderr from now until the mocks are restored. */
function printed(): string[] {
  const written: string[] = [];
  const keep = (text: string | Uint8Array): boolean => {
    written.push(streamText(text));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(keep);
  vi.spyOn(process.stderr, 'write').mockImplementation(keep);
  return written;
}

/** `pnpm worker` against a fake API answering `answer`, or a proposal's ordinary success. */
async function run(argv: string[], answer: (call: Sent) => Response | undefined) {
  const output = printed();
  const signIns = gotrue();
  const sent: Sent[] = [];
  const beats: (string | undefined)[] = [];
  const transport: Transport = (path, body, bearer) => {
    const call = { verb: verbOf(path), body: JSON.parse(body) as Record<string, unknown>, bearer };
    sent.push(call);
    return Promise.resolve(answer(call) ?? proposing(call.verb));
  };
  const beat = (address: string | undefined): Promise<string> => {
    beats.push(address);
    return Promise.resolve('sent');
  };
  const code = await main(argv, SETTINGS, beat, {
    transport: () => transport,
    signIn: signIns.fetch,
  });
  const text = output.join('');
  const secrets = [PASSWORD, DELEGATION, ...signIns.issued];
  return {
    code,
    sent,
    beats,
    text,
    issued: signIns.issued,
    printedSecret: secrets.some((one) => text.includes(one)),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the worker renews its own sign-in', () => {
  it('signs in again once on AUTH_SESSION_EXPIRED and sends the same call, then pings', async () => {
    const ran = await run(['--once'], (call) =>
      call.bearer === 'bearer-canary-1' ? refusal('AUTH_SESSION_EXPIRED') : undefined,
    );
    expect(ran.code).toBe(0);
    expect(ran.issued).toHaveLength(2);
    const [refused, retried, ...rest] = ran.sent;
    expect([refused?.bearer, retried?.bearer]).toEqual(['bearer-canary-1', 'bearer-canary-2']);
    expect(retried?.verb).toBe(refused?.verb);
    expect(retried?.body['operationId']).toBe(refused?.body['operationId']);
    expect(rest.map((call) => call.bearer)).toEqual(['bearer-canary-2', 'bearer-canary-2']);
    expect(ran.beats).toEqual([HEARTBEAT]);
    expect(ran.text).toContain('"proposed"');
    expect(ran.printedSecret, 'a credential was printed').toBe(false);
  });

  it('renews a bearer before it runs out, one sign-in for callers asking at once', async () => {
    let now = 0;
    const signIns = gotrue(100);
    const login = {
      gotrueUrl: 'http://127.0.0.1:1',
      email: 'agent@example.test',
      password: PASSWORD,
    };
    const bearer = await agentSignIn(
      { ...login, providerKey: '' },
      vi.fn(),
      signIns.fetch,
      () => now,
    );
    if ('because' in bearer) throw new Error(bearer.because);
    now = 79_000;
    expect(await bearer.current()).toBe('bearer-canary-1');
    now = 81_000;
    const both = await Promise.all([bearer.current(), bearer.current()]);
    expect(both).toEqual(['bearer-canary-2', 'bearer-canary-2']);
    expect(signIns.issued).toHaveLength(2);
  });
});

describe('a renewal the sign-in service fails', () => {
  it('after a failed renewal it keeps the bearer it has for a while, asking again later', async () => {
    let now = 0;
    let up = true;
    const signIns = gotrue(100);
    const flaky = ((...args: Parameters<typeof fetch>) =>
      up ? signIns.fetch(...args) : Promise.reject(new Error('down'))) as typeof fetch;
    const failed = vi.fn();
    const login = {
      gotrueUrl: 'http://127.0.0.1:1',
      email: 'agent@example.test',
      password: PASSWORD,
    };
    const bearer = await agentSignIn({ ...login, providerKey: '' }, failed, flaky, () => now);
    if ('because' in bearer) throw new Error(bearer.because);
    up = false;
    now = 81_000;
    expect(await bearer.current()).toBe('bearer-canary-1');
    expect(await bearer.current()).toBe('bearer-canary-1');
    expect(failed).toHaveBeenCalledTimes(1);
    up = true;
    now = 111_000;
    expect(await bearer.current()).toBe('bearer-canary-2');
  });
});

describe('a worker that cannot sign in does not start', () => {
  it('a refused first sign-in ends the start, naming the setting and not the password', async () => {
    const output = printed();
    const refused = (() =>
      Promise.resolve(
        Response.json({ msg: 'Invalid login credentials' }, { status: 400 }),
      )) as typeof fetch;
    const transport = vi.fn<Transport>();
    const code = await main(['--once'], SETTINGS, vi.fn(), {
      transport: () => transport,
      signIn: refused,
    });
    expect(code).toBe(1);
    expect(transport).not.toHaveBeenCalled();
    expect(output.join('')).toContain('OPS_ASTRO_EMAIL: Invalid login credentials');
    expect(output.join('').includes(PASSWORD)).toBe(false);
  });
});

describe('a worker its credentials no longer let in exits, naming the setting', () => {
  it.each([
    ['DELEGATION_NOT_LIVE', 'OPS_ASTRO_DELEGATION', 1],
    ['AUTH_UNKNOWN_LOGIN', 'OPS_ASTRO_EMAIL and OPS_ASTRO_PASSWORD', 1],
    // An expired sign-in is renewed once in each pass and asked again.
    ['AUTH_SESSION_EXPIRED', 'OPS_ASTRO_EMAIL and OPS_ASTRO_PASSWORD', 2],
  ])('after ten passes refused %s, exit 1 naming %s', async (code, named, perPass) => {
    const ran = await run([], () => refusal(code));
    expect(ran.code).toBe(1);
    expect(ran.sent).toHaveLength(10 * perPass);
    expect(ran.beats).toEqual([]);
    const lines = ran.text.split('\n').filter((line) => line.startsWith('worker: '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(named);
    expect(ran.printedSecret, 'a credential was printed').toBe(false);
  });

  it('a pass that is let in starts the count again', async () => {
    let passes = 0;
    // Nine passes refused, the tenth let in to propose, then every poll after it refused.
    const ran = await run([], (call) => {
      if (call.verb === 'session.capabilities') passes += 1;
      const letIn = passes === 10 && PROPOSING.includes(call.verb as CommandName);
      return letIn ? undefined : refusal('DELEGATION_NOT_LIVE');
    });
    expect(ran.code).toBe(1);
    expect(passes).toBe(10);
    expect(ran.sent.filter((call) => call.verb.endsWith(pathOf('task.queue')))).toHaveLength(10);
  });
});

/** An `expiresAt` `ms` from now. */
const at = (ms: number): string => new Date(Date.now() + ms).toISOString();

/** The API for one task's work, its dispatch answer lost once: the work is held for the next pass. */
function heldWork(): {
  sent: { path: string; body: unknown; delegation?: string }[];
  transport: Transport;
} {
  const sent: { path: string; body: unknown; delegation?: string }[] = [];
  let dispatches = 0;
  const transport: Transport = (path, body, _bearer, delegation) => {
    sent.push({
      path,
      body: JSON.parse(body),
      ...(delegation === undefined ? {} : { delegation }),
    });
    const ends = (verb: CommandName) => path.endsWith(pathOf(verb));
    const lease = { leaseId: 'lease-1', fence: 3 };
    const mine = { taskId: 'task-1', proposedByActorId: 'agent-1', purpose: 'synthetic_comment' };
    let answer = refusal('LAUNCH_NOT_DECIDED');
    if (ends('session.capabilities')) answer = Response.json({ agentActorId: 'agent-1' });
    if (ends('task.queue')) answer = Response.json({ detail: { queue: [mine] } });
    // A lease already at its halfway mark: the next pass that resumes it beats first.
    const picked = { ...lease, attemptId: 'attempt-1', credential: 'pickup-delegation' };
    if (ends('task.pickup')) answer = Response.json({ detail: { ...picked, expiresAt: at(0) } });
    if (ends('task.heartbeat'))
      answer = Response.json({ detail: { ...lease, expiresAt: at(9e5) } });
    if (ends('task.dispatch') && ++dispatches === 1) answer = new Response(null, { status: 503 });
    return Promise.resolve(answer);
  };
  return { sent, transport };
}

describe('work held from one pass to the next keeps its lease alive', () => {
  it('a resumed pass sends task.heartbeat under the pickup’s own delegation first', async () => {
    const { sent, transport } = heldWork();
    const worker = createWorker({
      transport,
      businessKey: 'alpha',
      credential: 'made-up-bearer',
      delegation: 'made-up-delegation',
      reporter: SYNTHETIC_USAGE,
    });
    expect(await worker.applyOnce('task-1')).toStrictEqual({ fault: { status: 503 } });
    const first = sent.length;
    expect(sent.some((call) => call.path.endsWith(pathOf('task.heartbeat')))).toBe(false);
    await worker.applyOnce('task-1');
    const [beat, again] = sent.slice(first);
    expect(beat?.path.endsWith(pathOf('task.heartbeat'))).toBe(true);
    expect(beat?.body).toMatchObject({ leaseId: 'lease-1', fence: 3 });
    expect(beat?.delegation).toBe('pickup-delegation');
    expect(again?.path.endsWith(pathOf('task.dispatch'))).toBe(true);
  });
});
