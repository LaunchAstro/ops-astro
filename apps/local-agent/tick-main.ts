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
//
// The approval gate (approval.ts) runs in each pass: approved approvals are
// written before the task pass, and a model step that comes back released is
// checked against the runner's own gate (gate.ts) on the runner's folder and
// cap, read from the runner's settings (OPS_LOCAL_AGENT_HOME, _CAP_USD,
// _SEAT, _SEAT_USAGE_FILE; set them as the runner was started). The broker
// does not say why a call was released; at the cap, or on a model the owner
// has not approved, the work is handed back asking the owner, and any other
// release raises nothing.

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { brokerSettings, startModelBroker } from '../api/model-broker.ts';
import {
  LOCAL_CLAUDE_COMPOSE,
  LOCAL_CLAUDE_DEFAULT_MODEL,
} from '../../packages/core-connectors/src/index.ts';
import {
  connect,
  isBusinessId,
  type BusinessId,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import {
  APPROVAL_PURPOSE,
  applyApprovals,
  needOf,
  raiseApproval,
  type ApprovalOptions,
} from './approval.ts';
import { decide, type GateSettings } from './gate.ts';
import { DEFAULT_CAP_USD, SEATS } from './settings.ts';
import { localOnly, startTicking, type Tick, type TickGate } from './tick.ts';

export interface TickProcessSettings {
  readonly databaseUrl: string;
  readonly businessId: BusinessId;
  readonly agent: VerifiedSubject;
  readonly workerActorId: string;
  readonly intervalMs: number;
  /** The runner's folder and cap, for the approval gate. */
  readonly gate: GateSettings;
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
  const gate = gateSettings(env);
  if (typeof gate === 'string') return missing(gate);
  return {
    ok: true,
    settings: {
      databaseUrl,
      businessId,
      agent: { provider, subject },
      workerActorId,
      intervalMs: seconds * 1000,
      gate,
    },
  };
}

/** The runner's gate settings as the runner reads them, or the name of the one that is not valid. */
function gateSettings(env: Readonly<Record<string, string | undefined>>): GateSettings | string {
  const home = env['OPS_LOCAL_AGENT_HOME'] || join(homedir(), '.ops-astro-local-agent');
  if (!isAbsolute(home)) return 'OPS_LOCAL_AGENT_HOME';
  const cap = env['OPS_LOCAL_AGENT_CAP_USD'] ?? '';
  if (cap !== '' && !/^\d{1,5}(\.\d{1,2})?$/u.test(cap)) return 'OPS_LOCAL_AGENT_CAP_USD';
  const capUsd = cap === '' ? DEFAULT_CAP_USD : Number(cap);
  if (capUsd <= 0) return 'OPS_LOCAL_AGENT_CAP_USD';
  const seat = SEATS.find((known) => known === env['OPS_LOCAL_AGENT_SEAT']);
  const usageFile = env['OPS_LOCAL_AGENT_SEAT_USAGE_FILE'] || null;
  return { home, capUsd, ...(seat === undefined ? {} : { seat }), usageFile };
}

/**
 * The approval gate for the tick, on approval.ts and the runner's own gate.
 * A release the gate explains (the cap, an unapproved model) hands the work
 * back asking the owner, once while the ask is open; any other raises nothing.
 */
export function localGate(
  approval: ApprovalOptions,
  settings: GateSettings,
  model: string = LOCAL_CLAUDE_DEFAULT_MODEL,
): TickGate {
  return {
    purpose: APPROVAL_PURPOSE,
    beforeTasks: async () => {
      await applyApprovals(approval);
    },
    onReleased: async (lease) => {
      const decision = decide(settings, model);
      if (decision.ok) return;
      const { code } = decision;
      if (code !== 'LOCAL_CAP_REACHED' && code !== 'LOCAL_MODEL_NOT_APPROVED') return;
      const raised = await raiseApproval(approval, lease, needOf(code, model));
      return raised.ok ? code : raised.code;
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

/** The approval gate's business, agent and folder, from the tick's settings. */
const approvalOf = (settings: TickProcessSettings) => ({
  businessId: settings.businessId,
  agent: settings.agent,
  home: settings.gate.home,
});

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
      gate: localGate({ ...approvalOf(settings), environment: env, database }, settings.gate),
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
