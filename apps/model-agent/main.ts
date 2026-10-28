// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's process on the owner's machine (`docs/local/model-agent.md`):
// its settings, its agent login, custody with Ollama on loopback (and
// OpenRouter, the owner's ChatGPT plan and Hermes Agent, where its settings name them), then
// calls carried over Realtime
// until stopped. A custody that stops answering its heartbeat ends the
// process, and launchd starts it again.

import { readFileSync, statSync } from 'node:fs';
import { loadavg } from 'node:os';
import {
  CHATGPT_PLAN_PROVIDER,
  HERMES_CONVERSATION,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseCarryKeys,
  realtimeCarriage,
  startCustody,
  type Destination,
  type ProcessCustody,
} from '../../packages/core-custody/src/agent.ts';
import { agentSignIn } from '../worker/sign-in.ts';
import { startModelAgent, type AgentCustody } from './carrier.ts';
import { renewing } from './renewing.ts';
import { parseAgentSettings, type AgentSettings } from './settings.ts';

const SETTINGS = 'MODEL_AGENT_SETTINGS';
/** The doorbell is joined again with a fresh token this often; a token lives an hour. */
const REJOIN_MS = 20 * 60_000;
const HEARTBEAT_MS = 30_000;

const say = (kind: string): void => void process.stdout.write(`model agent: ${kind}\n`);

/** The settings, from a file only its owner can read, or why not. */
function settingsFrom(file: string | undefined): AgentSettings | string {
  if (file === undefined || file === '') return `${SETTINGS} names no file`;
  try {
    if ((statSync(file).mode & 0o077) !== 0) return 'the settings file is readable by others';
    const parsed = parseAgentSettings(readFileSync(file, 'utf8'));
    return parsed.ok ? parsed.settings : parsed.problem;
  } catch {
    return 'the settings file is unreadable';
  }
}

/** 0 once told to stop, 1 once custody no longer answers its heartbeat. */
async function untilStopped(custody: ProcessCustody, ref: string): Promise<number> {
  return await new Promise<number>((done) => {
    const heartbeat = setInterval(() => {
      void (async () => {
        if ((await custody.describe(ref, 'ollama')) !== null) return;
        clearInterval(heartbeat);
        done(1);
      })();
    }, HEARTBEAT_MS);
    process.once('SIGTERM', () => {
      clearInterval(heartbeat);
      done(0);
    });
  });
}

/** Custody's destinations: Ollama on loopback, and OpenRouter's stream, the plan and Hermes Agent's stream where they are set. */
export const destinationsOf = (settings: AgentSettings): readonly Destination[] => [
  { key: 'ollama', origin: settings.ollamaOrigin },
  ...(settings.openrouterOrigin === undefined
    ? []
    : [{ key: 'openrouter', origin: settings.openrouterOrigin, stream: 'openai_sse' as const }]),
  ...(settings.planOrigin === undefined
    ? []
    : [{ key: CHATGPT_PLAN_PROVIDER, origin: settings.planOrigin }]),
  ...(settings.hermesOrigin === undefined
    ? []
    : [
        {
          key: HERMES_CONVERSATION.destination,
          origin: settings.hermesOrigin,
          stream: 'openai_sse' as const,
        },
      ]),
];

/** The value each destination's request goes under: a credential reference, the plan itself, or none. */
function refFor(settings: Parameters<typeof agentCustody>[0], destination: string) {
  if (destination === 'openrouter') return settings.openrouterCredentialRef;
  if (destination === HERMES_CONVERSATION.destination) return settings.hermesCredentialRef;
  if (destination !== CHATGPT_PLAN_PROVIDER) return settings.credentialRef;
  // The plan's token is custody's holder's, never a filed credential.
  return settings.planTokenFile === undefined ? undefined : CHATGPT_PLAN_PROVIDER;
}

/**
 * Custody as the agent hands it a call, under the request's own
 * destination's credential; an OpenRouter, plan or Hermes request with none set is
 * refused, and custody is asked nothing. With the plan set, custody is asked
 * to prepare its token before each accept.
 */
export const agentCustody = (
  settings: Pick<
    AgentSettings,
    'credentialRef' | 'openrouterCredentialRef' | 'planTokenFile' | 'hermesCredentialRef'
  >,
  custody: Pick<ProcessCustody, 'dispatchBefore'> & Partial<Pick<ProcessCustody, 'prepare'>>,
): AgentCustody => ({
  dispatch: async (request, gate, onPiece) => {
    const ref = refFor(settings, request.destination);
    if (ref === undefined) return { kind: 'refused', started: false, code: 'REQUEST_REFUSED' };
    return await custody.dispatchBefore(ref, request, gate, onPiece);
  },
  ...(settings.planTokenFile === undefined || custody.prepare === undefined
    ? {}
    : { prepare: custody.prepare }),
});

export async function main(env: NodeJS.ProcessEnv): Promise<number> {
  const settings = settingsFrom(env[SETTINGS]);
  if (typeof settings === 'string') {
    process.stderr.write(`model agent: ${settings}\n`);
    return 2;
  }
  const keys = parseCarryKeys(settings.carryKey, settings.carryKeyNext);
  if (!keys.ok) return 2;
  const bearer = await agentSignIn(settings, () => say('sign-in renewal failed'));
  if ('because' in bearer) {
    process.stderr.write('model agent: the agent login was refused\n');
    return 1;
  }
  const { planTokenFile, planIssuer } = settings;
  const custody = await startCustody({
    credentialsFile: settings.credentialsFile,
    destinations: destinationsOf(settings),
    ...(planTokenFile === undefined || planIssuer === undefined
      ? {}
      : { plan: { tokenFile: planTokenFile, issuer: planIssuer } }),
  });
  const carriage = realtimeCarriage({ url: settings.realtimeUrl, apiKey: settings.providerKey });
  const agent = await startModelAgent({
    carriage: renewing(carriage, bearer.current, REJOIN_MS),
    keys: keys.keys,
    key: settings.carryKey,
    business: settings.business,
    agent: settings.agent,
    token: bearer.current,
    custody: agentCustody(settings, custody),
    load: () => loadavg()[0] ?? 0,
    log: say,
  });
  if ('because' in agent) {
    process.stderr.write('model agent: the doorbell could not be joined\n');
    await custody.stop();
    return 1;
  }
  const code = await untilStopped(custody, settings.credentialRef);
  await Promise.all([agent.stop(), custody.stop()]);
  return code;
}

if (import.meta.main) process.exitCode = await main(process.env);
