// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, installSpine, grantTo, addClient, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';
import type { ReadRequest, ReadResult } from '../../packages/core-commands/src/reads/requests.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { CommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
export interface ScopeWorld {
  readonly db: FreshDatabase;
  readonly business: string;
  readonly foreign: string;
  readonly owner: Member;
  readonly teammate: Member;
  readonly limited: Member;
  readonly taskOnly: Member;
  readonly foreignOwner: Member;
  readonly clientA: string;
  readonly clientB: string;
  readonly foreignClient: string;
  readonly own: string;
  readonly teamA: string;
  readonly teamB: string;
}
export async function scopeCommand(
  w: Pick<ScopeWorld, 'db' | 'business' | 'owner'>,
  body: UncheckedRequest,
): Promise<CommandResult> {
  return await executeCommand(w.db.app, w.business, w.owner.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  });
}
function applied(answer: CommandResult): { readonly id: string; readonly revision: number } {
  if (isCommandRefusal(answer))
    throw new Error(`Typed scope fixture command refused ${answer.code}`);
  if (answer.recordId === null || answer.revision === null)
    throw new Error('Typed scope fixture command has no task identity');
  return { id: answer.recordId, revision: answer.revision };
}
async function newTask(
  w: Pick<ScopeWorld, 'db' | 'business' | 'owner'>,
  title: string,
  person: Member,
  client?: string,
): Promise<string> {
  let at = applied(
    await scopeCommand(w, {
      command: 'task.create',
      fields: { title },
    }),
  );
  if (client !== undefined)
    at = applied(
      await scopeCommand(w, {
        command: 'task.set_party',
        recordId: at.id,
        expectedRevision: at.revision,
        fields: { client },
      }),
    );
  at = applied(
    await scopeCommand(w, {
      command: 'task.assign',
      recordId: at.id,
      expectedRevision: at.revision,
      fields: { assignee: person.personId },
    }),
  );
  return at.id;
}
export async function scopeWorld(): Promise<ScopeWorld> {
  if (databaseUrlFromEnvironment() === undefined)
    throw new Error('Typed scope requires the normal synthetic scratch DB, no skips');
  const db = await createFreshDatabase({ part: 'typed_scope_typed_scope' });
  try {
    const business = await insertBusiness(db.app, `typed_scope-alpha-${randomUUID()}`);
    const foreign = await insertBusiness(db.app, `typed_scope-bravo-${randomUUID()}`);
    await installSpine(db.app, business);
    await installSpine(db.app, foreign);
    const owner = await enrol(db.app, business, 'Typed scope owner');
    const teammate = await enrol(db.app, business, 'Typed scope teammate');
    const limited = await enrol(db.app, business, 'Typed scope client A only');
    const taskOnly = await enrol(db.app, business, 'Typed scope no vocabulary');
    const foreignOwner = await enrol(db.app, foreign, 'Typed scope foreign owner');
    await db.app.withBusiness(business, async (tx) => {
      await Promise.all(
        ['read', 'write', 'share', 'assign'].map((action) => {
          if (action === 'read' || action === 'write' || action === 'share' || action === 'assign')
            return grantTo(tx, owner, action);
          throw new Error('Invalid fixture action');
        }),
      );
      await grantTo(tx, owner, 'read', undefined, false, 'person');
      await grantTo(tx, taskOnly, 'read');
    });
    await db.app.withBusiness(foreign, async (tx) => {
      await grantTo(tx, foreignOwner, 'read');
      await grantTo(tx, foreignOwner, 'write');
      await grantTo(tx, foreignOwner, 'share');
      await grantTo(tx, foreignOwner, 'assign');
    });
    return await seedWork({
      db,
      business,
      foreign,
      owner,
      teammate,
      limited,
      taskOnly,
      foreignOwner,
    });
  } catch (error) {
    await db.drop();
    throw error;
  }
}
async function seedWork(
  identity: Omit<ScopeWorld, 'clientA' | 'clientB' | 'foreignClient' | 'own' | 'teamA' | 'teamB'>,
): Promise<ScopeWorld> {
  const { db, business, foreign, owner, teammate, limited } = identity;
  const clientA = randomUUID(),
    clientB = randomUUID(),
    foreignClient = randomUUID();
  await addClient(db.app, business, clientA, owner);
  await addClient(db.app, business, clientB, owner);
  await addClient(db.app, foreign, foreignClient, identity.foreignOwner);
  const local = { db, business, owner };
  const own = await newTask(local, 'Typed scope own work', owner, clientA);
  const teamA = await newTask(local, 'Typed scope teammate client A', teammate, clientA);
  const teamB = await newTask(local, 'Typed scope teammate client B canary', teammate, clientB);
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, limited, 'read', { kind: 'record', id: teamA });
  });
  return {
    ...identity,
    clientA,
    clientB,
    foreignClient,
    own,
    teamA,
    teamB,
  };
}
export async function scopeRead(
  w: ScopeWorld,
  request: ReadRequest,
  by: Member = w.owner,
): Promise<ReadResult | CommandRefusal> {
  return await executeRead(w.db.app, w.business, by.presented, request);
}
