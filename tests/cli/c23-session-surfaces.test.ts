// SPDX-License-Identifier: AGPL-3.0-only
//
// C23's two self operations on every surface, against the real served API:
// the command line as its own process, the HTTP routes it posts to on the
// person prefix and the agent prefix, and the in-process entries the app
// serves through. `session.person` answers the caller's own name and
// `session.end` records the caller's own sign-out on the audit chain, the same
// way on each; an agent is refused both on each, with or without a live
// delegation; a body naming anyone is refused on each, and nothing is recorded
// for the person it names.
//
// Separations named: person to person (a sign-out naming mia is refused and
// mia's record is untouched; each surface answers ada's name, never another's);
// another person under a live delegation (the agent is refused, and its
// attempts are on the chain as refused). No output carries the delegation
// credential.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executeAgentCommand,
  executeCommand,
  executeRead,
  isCommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import {
  readAuditEvents,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import { PREFIX, pathOf, type CommandName } from '../../packages/core-wire/src/index.ts';
import { createWorld, serverUrl, type Caller, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

type Surface = 'cli' | 'http' | 'entry';
const SURFACES: readonly Surface[] = ['cli', 'http', 'entry'];
const END: CommandName = 'session.end';
const PERSON: CommandName = 'session.person';

let world: World;
let api: ServedApi | undefined;
let scratch: string;

const env = (token: string, extra: Readonly<Record<string, string>> = {}) => ({
  OPS_ASTRO_API_URL: (api as ServedApi).origin,
  OPS_ASTRO_BUSINESS: 'alpha',
  OPS_ASTRO_TOKEN: token,
  OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
  OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
  ...extra,
});

function detailOf(run: Run): Record<string, unknown> {
  const detail = run.json?.['detail'];
  if (typeof detail !== 'object' || detail === null) {
    throw new Error(`no detail: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return detail as Record<string, unknown>;
}

/** A live delegation for the agent: approved work on a new task, picked up. */
async function delegation(): Promise<string> {
  const person = env(world.ada.token);
  const task = await runCli(
    ['task.create', '--json', JSON.stringify({ fields: { title: 'sign-out surfaces' } })],
    person,
  );
  const proposal = {
    recordId: String(task.json?.['recordId']),
    expectedRevision: task.json?.['revision'],
    purpose: `c23_${randomUUID().slice(0, 8)}`,
    maximumMinor: 2_000,
    currency: 'AUD',
    payload: { change: 'a team-only comment' },
    step: { kind: 'synthetic_comment', payload: {} },
  };
  const gate = detailOf(await runCli(['task.propose', '--json', JSON.stringify(proposal)], person));
  const decision = { gateId: gate['gateId'], versionId: gate['versionId'], decision: 'approve' };
  const decided = await runCli(
    ['task.decide', '--json', JSON.stringify({ ...decision, note: 'approved' })],
    person,
  );
  const file = join(scratch, `delegation-${randomUUID()}`);
  const pickup = await runCli(
    [
      'task.pickup',
      '--agent',
      '--json',
      JSON.stringify({ reservationId: detailOf(decided)['reservationId'] }),
    ],
    env(world.agent.token, { OPS_ASTRO_DELEGATION_FILE: file }),
  );
  expect(pickup.code, pickup.stdout).toBe(0);
  return readFileSync(file, 'utf8').trim();
}

/** What one answer came to: `applied`, the refusal's code, or the name answered. */
function outcomeOf(answer: Readonly<Record<string, unknown>> | undefined): string {
  if (answer === undefined) return 'no answer';
  if (answer['refused'] === true || typeof answer['code'] === 'string') {
    return String(answer['code']);
  }
  const person = answer['person'] as { readonly name?: unknown } | undefined;
  return person === undefined ? 'applied' : `name:${String(person.name)}`;
}

/** One call as a person, on one surface. */
async function asPerson(
  surface: Surface,
  who: Caller,
  name: CommandName,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const sent = name === END ? { operationId: randomUUID(), ...extra } : { ...extra };
  if (surface === 'cli') {
    return outcomeOf((await runCli([name, '--json', JSON.stringify(sent)], env(who.token))).json);
  }
  if (surface === 'http') {
    const response = await fetch(
      `${(api as ServedApi).origin}${PREFIX.person}alpha${pathOf(name)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
        body: JSON.stringify(sent),
      },
    );
    return outcomeOf((await response.json()) as Record<string, unknown>);
  }
  const answer =
    name === END
      ? await executeCommand(world.db.app, world.alpha, who.presented, 'api', {
          command: END,
          ...sent,
        } as never)
      : await executeRead(world.db.app, world.alpha, who.presented, {
          read: PERSON,
          ...sent,
        } as unknown as ReadRequest);
  return isCommandRefusal(answer) ? answer.code : outcomeOf(answer as never);
}

/** One call as the agent, on one surface, with or without its delegation. */
async function asAgent(surface: Surface, name: CommandName, credential?: string): Promise<string> {
  const sent = name === END ? { operationId: randomUUID() } : {};
  if (surface === 'cli') {
    const extra: Record<string, string> = { OPS_ASTRO_AGENT: '1' };
    if (credential !== undefined) extra['OPS_ASTRO_DELEGATION'] = credential;
    const run = await runCli([name, '--json', JSON.stringify(sent)], env(world.agent.token, extra));
    if (credential !== undefined) expect(run.stdout + run.stderr).not.toContain(credential);
    return outcomeOf(run.json);
  }
  if (surface === 'http') {
    const response = await fetch(
      `${(api as ServedApi).origin}${PREFIX.agent}alpha${pathOf(name)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${world.agent.token}`,
          ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
        },
        body: JSON.stringify(sent),
      },
    );
    const text = await response.text();
    if (credential !== undefined) expect(text).not.toContain(credential);
    return outcomeOf(JSON.parse(text) as Record<string, unknown>);
  }
  const answer = await executeAgentCommand(
    world.db.app,
    world.alpha,
    world.agent.presented,
    credential ?? '',
    { command: name, ...sent } as never,
  );
  return isCommandRefusal(answer) ? answer.code : outcomeOf(answer as never);
}

const signOuts = async (actorId: string): Promise<string[]> =>
  await world.db.app.withBusiness(world.alpha, async (tx) =>
    (await readAuditEvents(tx))
      .filter((event) => event.command === END && event.actor_id === actorId)
      .map((event) => String(event.outcome)),
  );

const nameOf = async (who: Caller): Promise<string> =>
  String(
    (
      await world.db.admin.execute<{ readonly display_name: string }>(
        'select display_name from public.people where id = $1',
        [who.personId],
      )
    )[0]?.display_name,
  );

/** Each surface's answer to `ask`, in surface order, one call at a time. */
async function onEach(ask: (surface: Surface) => Promise<string>): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const surface of SURFACES) {
    // eslint-disable-next-line no-await-in-loop
    answers[surface] = await ask(surface);
  }
  return answers;
}

const same = (value: string) => ({ cli: value, http: value, entry: value });

// One world for both groups below, which run in order in this file.
if (serverUrl !== undefined) {
  beforeAll(async () => {
    world = await createWorld('c23surf');
    scratch = mkdtempSync(join(tmpdir(), 'c23-surfaces-'));
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);
}

describe.skipIf(serverUrl === undefined)(
  'C23 session.end and session.person on every surface',
  () => {
    it('session.person answers the caller its own name on each surface', async () => {
      const ada = `name:${await nameOf(world.ada)}`;
      expect(await onEach(async (surface) => await asPerson(surface, world.ada, PERSON))).toEqual(
        same(ada),
      );
      const mia = `name:${await nameOf(world.mia)}`;
      expect(mia).not.toBe(ada);
      expect(await onEach(async (surface) => await asPerson(surface, world.mia, PERSON))).toEqual(
        same(mia),
      );
    });

    it('session.end is applied on each surface, one sign-out each on an intact chain', async () => {
      const before = await signOuts(String(world.ada.actorId));
      expect(await onEach(async (surface) => await asPerson(surface, world.ada, END))).toEqual(
        same('applied'),
      );
      expect(await signOuts(String(world.ada.actorId))).toEqual([
        ...before,
        'applied',
        'applied',
        'applied',
      ]);
      const chain = await world.db.app.withBusiness(world.alpha, verifyAuditChain);
      expect(chain).toMatchObject({ intact: true, firstBreak: undefined });
    });
  },
);

describe.skipIf(serverUrl === undefined)('C23 the same refusals on every surface', () => {
  it('a sign-out naming another person is refused alike on each, and records nothing for them', async () => {
    const miaBefore = await signOuts(String(world.mia.actorId));
    const answers = await onEach(
      async (surface) =>
        await asPerson(surface, world.ada, END, { personId: String(world.mia.personId) }),
    );
    expect(answers['cli']).not.toBe('applied');
    expect(answers).toEqual(same(String(answers['cli'])));
    expect(await signOuts(String(world.mia.actorId))).toEqual(miaBefore);
  });

  it('the agent is refused both alike on each, with and without its delegation', async () => {
    const credential = await delegation();
    const adaBefore = await signOuts(String(world.ada.actorId));
    for (const name of [END, PERSON]) {
      // eslint-disable-next-line no-await-in-loop
      const held = await onEach(async (surface) => await asAgent(surface, name, credential));
      expect(held, name).toEqual(same('DELEGATION_EXCLUDES_OPERATION'));
      // eslint-disable-next-line no-await-in-loop
      const bare = await onEach(async (surface) => await asAgent(surface, name));
      expect(bare['cli'], name).not.toBe('applied');
      expect(bare['cli'], name).not.toMatch(/^name:/u);
      // Without a delegation, the command line and the HTTP route answer alike.
      expect(bare['http'], name).toBe(bare['cli']);
    }
    const agentAttempts = await signOuts(String(world.agent.actorId));
    expect(agentAttempts.length).toBeGreaterThan(0);
    expect(agentAttempts.every((outcome) => outcome === 'refused')).toBe(true);
    expect(await signOuts(String(world.ada.actorId))).toEqual(adaBefore);
  });
});
