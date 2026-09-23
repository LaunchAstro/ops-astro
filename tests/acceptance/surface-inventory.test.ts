// SPDX-License-Identifier: AGPL-3.0-only
//
// Item 1: the inventory, generated from the real exports.
//
// SPEC section 8's first property is that the enumeration is **generated from
// the exported operation surface, not maintained by hand**, so that an endpoint
// added without a case fails the build. This file is where that generation
// happens: every case below iterates `COMMAND_SURFACE` itself, and there is no
// list of operation names anywhere in it. Adding a declaration adds a case, and
// a declaration that is unreachable on any of the four surfaces fails here.
//
// The four surfaces are the ones a caller actually has:
//
//   1. the API's person prefix   `/api/b/:businessKey`
//   2. the API's agent prefix    `/api/a/b/:businessKey`
//   3. `apps/cli/client.ts`      the ordinary command line
//   4. `apps/web/src/operations/client.ts` the mounted app's client
//
// **Reachable means routed, not permitted.** A declaration is reachable when
// the request arrives at the operation that owns the rule — anything but a 404,
// and on the CLI anything but its own `COMMAND_UNKNOWN`. Whether the operation
// then says yes or no is authority, and authority is `role-case-matrix.test.ts`.
// Collapsing the two would let a route that refuses everyone count as proof
// that the surface is served.

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  READS,
  pathOf,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import { accepts, createCli, usage } from '../../apps/cli/client.ts';
import {
  operationPath,
  READ_NAMES,
  type OperationName,
} from '../../apps/web/src/operations/client.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from './world.ts';

if (serverUrl === undefined) {
  console.warn('acceptance/inventory: DATABASE_URL is unset, so nothing below ran.');
}

/**
 * The reads the mounted app's client has a `read()` verb for.
 *
 * The client's own runtime list, `READ_NAMES`, from which `ReadName` is built.
 * It used to be a hand-kept copy of the type, which could not fail when the
 * union widened. Taking the client's list is not a derivation that agrees with
 * itself: the case compares it with the server's `COMMAND_SURFACE`, the other
 * side of the wire.
 */
const WEB_READ_VERBS: readonly string[] = READ_NAMES;

/**
 * Where a measured count goes.
 *
 * `console.log` is swallowed by the runner, and a count nobody can read is a
 * count nobody can quote. `.local/` is gitignored, so the evidence lands beside
 * the run rather than in the tree.
 */
function report(label: string, lines: readonly string[]): void {
  mkdirSync('.local', { recursive: true });
  appendFileSync('.local/l5-inventory.txt', `${label}: ${lines.join(', ')}\n`);
}

/**
 * The least a caller can send and still be asking the operation a question.
 *
 * It is not `{}`, and the reason is a defect this inventory found rather than a
 * convenience: see the recorded case at the foot of this file. A routing claim
 * made with a body that crashes the envelope would be measuring the crash.
 */
function minimalEnvelope(): Readonly<Record<string, unknown>> {
  return { operationId: randomUUID() };
}

describe.skipIf(serverUrl === undefined)('the exported surface, enumerated from itself', () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld('inv');
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it('records the counts this inventory is about', () => {
    const declarations = COMMAND_SURFACE.length;
    const reads = READS.length;
    const writes = declarations - reads;
    // Not a hand-kept total: it is read off the table and written out so the
    // handback quotes a measured number rather than a remembered one.
    report('declarations', [
      `${String(declarations)} total`,
      `${String(writes)} writes`,
      `${String(reads)} reads`,
    ]);
    expect(declarations).toBe(new Set(COMMAND_SURFACE.map((one) => one.name)).size);
    expect(declarations).toBeGreaterThan(0);
  });

  it('reaches every declaration on the person prefix', async () => {
    const unreachable: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      // eslint-disable-next-line no-await-in-loop -- one route at a time reads as a list
      const answer = await call(
        world.api,
        personPath('alpha', pathOf(declaration.name)),
        minimalEnvelope(),
        bearer(world.ada.token),
      );
      if (answer.status === 404) unreachable.push(declaration.name);
    }
    report('person-prefix reach', [
      `${String(COMMAND_SURFACE.length)} of ${String(COMMAND_SURFACE.length)} routed`,
    ]);
    expect(unreachable).toStrictEqual([]);
  });

  it('reaches every declaration on the agent prefix', async () => {
    // AUTHORITY.md mounts the agent's entry point on the same surface table:
    // "same surface table, same paths, a different prefix and a different
    // envelope". So the routing claim is the same claim, and what differs is
    // the envelope's answer, which is the matrix's case.
    const unreachable: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await call(
        world.api,
        agentPath('alpha', pathOf(declaration.name)),
        minimalEnvelope(),
        bearer(world.agent.token),
      );
      if (answer.status === 404) unreachable.push(declaration.name);
    }
    report('agent-prefix reach', [
      `${String(COMMAND_SURFACE.length - unreachable.length)} of ${String(COMMAND_SURFACE.length)} routed`,
    ]);
    expect(unreachable).toStrictEqual([]);
  });

  it('does not answer an operation that is not declared, on either prefix', async () => {
    for (const path of [personPath('alpha', '/task/invent'), agentPath('alpha', '/task/invent')]) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await call(world.api, path, minimalEnvelope(), bearer(world.ada.token));
      expect(answer.status, path).toBe(404);
    }
  });

  it('reaches every declaration through the command line', async () => {
    const cli = createCli({
      businessKey: 'alpha',
      credential: world.ada.token,
      // The real app, driven the way the real transport drives it.
      transport: async (path, body, credential) =>
        await world.api.fetch(
          new Request(`http://api.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
            body,
          }),
        ),
    });

    const notAVerb: string[] = [];
    const notRouted: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      if (!accepts(declaration.name)) notAVerb.push(declaration.name);
      // `createCli` reads every answer with `response.json()`, which throws on
      // a body that is not JSON. The five declarations recorded in the case
      // below answer a plain-text 500, so the throw is the API's fault
      // surfacing here rather than a routing failure — and catching it is what
      // keeps this case measuring what it claims to measure. That the command
      // line cannot report a fault at all is reported as a defect
      // (`apps/cli/client.ts:88`), not repaired here.
      let status: number;
      try {
        // eslint-disable-next-line no-await-in-loop
        status = (await cli.run(declaration.name, minimalEnvelope())).status;
      } catch {
        status = 500;
      }
      // 404 here is either the CLI's own `COMMAND_UNKNOWN` or the API's missing
      // route, and both mean the same thing for this claim: not reachable.
      if (status === 404) notRouted.push(declaration.name);
    }
    report('cli reach', [
      `${String(COMMAND_SURFACE.length - notRouted.length)} of ${String(COMMAND_SURFACE.length)} routed`,
    ]);
    expect(notAVerb).toStrictEqual([]);
    expect(notRouted).toStrictEqual([]);
    expect(usage()).toHaveLength(COMMAND_SURFACE.length);

    // The other half of the claim: the command line is not a wider surface than
    // the API either. An invented verb is refused by the client before a
    // request is made, and it is refused as "no such command" rather than as an
    // authority decision nobody took.
    const invented = await cli.run('task.invent', minimalEnvelope());
    expect(invented.status).toBe(404);
    expect((invented.body as Record<string, unknown>)['code']).toBe('COMMAND_UNKNOWN');
  });

  it('spells every declaration the same way on all four surfaces', () => {
    const disagreements: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      const server = pathOf(declaration.name);
      // The web client derives its own path from its own name type. If the two
      // derivations disagree, a caller reaches a route the server does not have.
      const web = operationPath(declaration.name as OperationName);
      if (server !== web) disagreements.push(`${declaration.name}: ${server} vs ${web}`);
    }
    expect(disagreements).toStrictEqual([]);
  });

  it('reaches every declared read as a read on the mounted app, with none left over', () => {
    // `OperationsClient.read()` takes `ReadName`. It was five names against
    // seven declared reads, and `task.queue` and `preset.plan` were reached only
    // through `mutate()`, with an operation identity a read does not carry.
    // SPEC-ADJUDICATE (b) ruled both required, so they joined `READ_NAMES`
    // and this case now requires none unreachable: taking either back out
    // fails here and in `tests/surfaces/read-names.test.ts`.
    const declaredReads = READS as readonly CommandName[];
    const unreachableAsReads = declaredReads.filter((name) => !WEB_READ_VERBS.includes(name));
    expect(unreachableAsReads).toStrictEqual([]);
    report('web read() reach', [
      `${String(WEB_READ_VERBS.length)} of ${String(declaredReads.length)} declared reads`,
    ]);
    // Every web read verb is a real declaration, which is the direction that
    // would otherwise let the client offer a read the server does not serve.
    for (const name of WEB_READ_VERBS) {
      expect(declaredReads, name).toContain(name);
    }
  });

  it('marks nothing as not-landed without saying what it waits for', () => {
    // A declared operation that refuses `DEPENDENCY_NOT_LANDED` is honest only
    // while it names the thing it is waiting for. This is the generated check
    // that the honesty is kept up as parts land.
    const silent = COMMAND_SURFACE.filter((one) => !one.landed && one.waitingOn === '');
    expect(silent).toStrictEqual([]);
    const notLanded = COMMAND_SURFACE.filter((one) => !one.landed).map((one) => one.name);
    report('not landed', notLanded.length === 0 ? ['none'] : notLanded);
  });

  it('answers every declaration with a result or a typed refusal, never a fault', async () => {
    // Every answer a caller can be given is meant to be one of two things: a
    // result, or a typed refusal carrying `refused: true` and a code. A third
    // thing exists — an unhandled fault, answered as a plain-text 500 — and the
    // mounted app's client draws it as *unavailable*, which is the word for a
    // server that fell over rather than one that decided. Checklist B7 requires
    // that distinction to be real, so a decision arriving as an outage is a
    // product defect and not a cosmetic one.
    //
    // Generated over the whole table with a well-formed envelope and no
    // operation-specific fields: the caller is authorised and the request is
    // shaped correctly as far as the envelope is concerned. `task.decide`
    // answers `FIELD_VALUE_INVALID` 422 for exactly this, so the pattern is in
    // the tree; these five do not reach it.
    //
    // On 2241725 five answered a fault here: `task.create`, `task.restore`,
    // `task.purge`, `task.read` and `preset.plan`, each for an absent operand
    // reaching a bound parameter or an `in` operator. L3-FAULTS answers each
    // with `FIELD_VALUE_INVALID` 422 by name (`commands/operands.ts`), and this
    // case now holds the whole table to none.
    const faulted: string[] = [];
    for (const declaration of COMMAND_SURFACE) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await call(
        world.api,
        personPath('alpha', pathOf(declaration.name)),
        minimalEnvelope(),
        bearer(world.ada.token),
      );
      if (answer.status >= 500) faulted.push(`${declaration.name} ${String(answer.status)}`);
    }
    report('person-prefix untyped faults', faulted.length === 0 ? ['none'] : faulted);
    expect(faulted).toStrictEqual([]);
  });

  // ── A defect this inventory found, fixed since ────────────────────────────
  //
  // On the head this suite was written against, `envelope.ts` guarded the
  // attempt identity with `OPERATION_ID.test(request.operationId)`, and
  // `RegExp.prototype.test` coerces its argument to a string: a request that
  // simply omitted the field coerced to `"undefined"`, passed the guard, and
  // the real `undefined` reached `lookupAttempt`'s bound parameter, so the
  // caller was handed a plain-text 500 instead of the typed 422 the status
  // table promises. `null` and `''` were refused correctly.
  //
  // This case recorded that behaviour as observed so that it failed the day
  // the defect was fixed. L3-PART-B-3 fixed it (the guard now checks the
  // type first), and the case now asserts the fix beside the two spellings
  // that were always right.
  it('answers an absent operationId with OPERATION_ID_REQUIRED, like null and the empty string', async () => {
    const answer = await call(
      world.api,
      personPath('alpha', pathOf('task.create')),
      { fields: { title: 'a body with no attempt identity' } },
      bearer(world.ada.token),
    );
    expect(answer.status).toBe(422);
    expect(answer.code).toBe('OPERATION_ID_REQUIRED');

    // The two spellings that were always refused correctly.
    for (const operationId of [null, '']) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await call(
        world.api,
        personPath('alpha', pathOf('task.create')),
        { operationId, fields: { title: 'a task' } },
        bearer(world.ada.token),
      );
      expect(refused.code, JSON.stringify(operationId)).toBe('OPERATION_ID_REQUIRED');
      expect(refused.status, JSON.stringify(operationId)).toBe(422);
    }
  });
});
