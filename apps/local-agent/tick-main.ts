// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's long-lived tick process (#859): `node apps/local-agent/tick-main.ts`,
// after sourcing the stack's `api.env`. One business, ticked every
// OPS_LOCAL_AGENT_TICK_SECONDS (60 by default, 10 at least): due schedules
// fired, queued task work picked up and its model step made on the
// `local-claude` route through the broker the API itself would start.
//
// It refuses before it opens anything: outside OPS_ENVIRONMENT=local, without
// OPS_AGENT_PROVIDER=local-claude, or without a database, a business id, the
// agent's login subject and the business's worker. It never prints a setting's
// value.

import { brokerSettings, startModelBroker } from '../api/model-broker.ts';
import { LOCAL_CLAUDE_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { connect, isBusinessId, type BusinessId } from '../../packages/core-records/src/index.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import { localOnly, startTicking, type Tick } from './tick.ts';

export interface TickProcessSettings {
  readonly databaseUrl: string;
  readonly businessId: BusinessId;
  readonly agent: VerifiedSubject;
  readonly workerActorId: string;
  readonly intervalMs: number;
}

export type TickSettings =
  | { readonly ok: true; readonly settings: TickProcessSettings }
  | {
      readonly ok: false;
      readonly code: 'LOCAL_ONLY' | 'PROVIDER_NOT_LOCAL' | 'SETTING_MISSING';
      readonly message: string;
    };

const missing = (name: string): TickSettings => ({
  ok: false,
  code: 'SETTING_MISSING',
  message: `${name} is not set or not valid`,
});

export function tickSettings(env: Readonly<Record<string, string | undefined>>): TickSettings {
  const refused = localOnly(env);
  if (refused !== undefined) return { ok: false, code: 'LOCAL_ONLY', message: refused.message };
  if (env['OPS_AGENT_PROVIDER'] !== 'local-claude') {
    return {
      ok: false,
      code: 'PROVIDER_NOT_LOCAL',
      message: 'the local tick runs only with OPS_AGENT_PROVIDER=local-claude',
    };
  }
  const databaseUrl = env['DATABASE_URL'] ?? '';
  if (databaseUrl === '') return missing('DATABASE_URL');
  const businessId = env['OPS_LOCAL_AGENT_BUSINESS_ID'] ?? '';
  if (!isBusinessId(businessId)) return missing('OPS_LOCAL_AGENT_BUSINESS_ID');
  const subject = env['OPS_LOCAL_AGENT_AGENT_SUBJECT'] ?? '';
  if (subject === '') return missing('OPS_LOCAL_AGENT_AGENT_SUBJECT');
  const workerActorId = env['OPS_LOCAL_AGENT_WORKER_ACTOR_ID'] ?? '';
  if (workerActorId === '') return missing('OPS_LOCAL_AGENT_WORKER_ACTOR_ID');
  const seconds = Number(env['OPS_LOCAL_AGENT_TICK_SECONDS'] ?? '60');
  if (!Number.isSafeInteger(seconds) || seconds < 10)
    return missing('OPS_LOCAL_AGENT_TICK_SECONDS');
  const provider = env['OPS_LOCAL_AGENT_AGENT_PROVIDER'] || 'supabase';
  return {
    ok: true,
    settings: {
      databaseUrl,
      businessId,
      agent: { provider, subject },
      workerActorId,
      intervalMs: seconds * 1000,
    },
  };
}

/** One line per pass: counts and refusal codes only, never the model's words. */
function reportOf(print: (line: string) => void) {
  return (pass: Tick | { readonly ok: false; readonly error: unknown }): void => {
    if (!pass.ok) {
      print(`local tick: ${'code' in pass ? pass.code : 'a pass failed'}`);
      return;
    }
    const refused = pass.ran.filter((ran) => ran.refusal !== null).map((ran) => ran.refusal?.code);
    print(
      `local tick: fired ${String(pass.fired.length)}, ran ${String(pass.ran.length)}` +
        (refused.length > 0 ? `, refused ${refused.join(' ')}` : ''),
    );
  };
}

export async function main(
  env: Readonly<Record<string, string | undefined>>,
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number | { readonly stop: () => Promise<void> }> {
  const read = tickSettings(env);
  if (!read.ok) {
    print(`${read.code}: ${read.message}`);
    return 1;
  }
  const broker = brokerSettings(env);
  if (broker.kind !== 'configured') {
    print(`the broker is ${broker.kind}: source the local stack's api.env first`);
    return 1;
  }
  const { settings } = read;
  const started = await startModelBroker(broker);
  const database = connect(settings.databaseUrl, { source: 'runtime' });
  const ticking = startTicking(
    {
      environment: env,
      database,
      businessId: settings.businessId,
      workerActorId: settings.workerActorId,
      agent: settings.agent,
      executeModelCall: started.executor,
      operation: LOCAL_CLAUDE_COMPOSE.key,
      fieldsFor: (entry) => [
        { name: 'instruction', from: { recordId: entry.taskId, key: 'title' } },
      ],
    },
    settings.intervalMs,
    reportOf(print),
  );
  if ('code' in ticking) {
    await started.stop();
    await database.close();
    return 1;
  }
  return {
    stop: async () => {
      await ticking.stop();
      await started.stop();
      await database.close();
    },
  };
}

if (import.meta.main) {
  const running = await main(process.env);
  if (typeof running === 'number') process.exit(running);
  const stop = (): void => {
    void running.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
