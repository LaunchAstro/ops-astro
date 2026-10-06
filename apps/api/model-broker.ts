// SPDX-License-Identifier: AGPL-3.0-only
//
// The credential broker, as the API's composition root configures it (AW-01).
//
// Four settings, all or none. None is a deployment with no broker, and
// `model.call` answers that the part it rests on has not landed. Some of
// them, or a malformed one, stops the server with a problem naming the
// setting and never its value: a destination or a route can carry a host
// the operator would not want in a log.
//
// The operations and their adapters are registered here in code and
// reviewed, never configured: the replay provider is the only one until the
// real-provider run (AW-RP).
//
// One more setting picks the provider per install (LA-1, #859):
// `OPS_AGENT_PROVIDER` unset or `api` is the broker exactly as above;
// `local-gpt` adds the owner's own ChatGPT plan through the local runner,
// and is refused unless `OPS_ENVIRONMENT` is `local`. Under it the
// conversation operation's key answers with the local declaration, and the
// broker carries LA-1's local carve-out for unattended work on that route.

import {
  catalogue,
  readReplayLookup,
  CONVERSATION_ANSWER,
  LOCAL_GPT_COMPOSE,
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_PROVIDER,
  localGptAdapter,
  localGptCostMinor,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
  replayLookup,
} from '../../packages/core-connectors/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import {
  parseDestinations,
  reconcileProviderCalls,
  startCustody,
  type BrokerRoute,
  type CredentialKind,
  type CustodyConfig,
  type Destination,
} from '../../packages/core-custody/src/index.ts';
import {
  callerAudit,
  conversationExchange,
  modelCallExecutor,
  type ConversationExchange,
  type ModelCallExecutor,
} from '../../packages/core-commands/src/index.ts';

export const MODEL_BROKER_SETTINGS = [
  'MODEL_BROKER_CREDENTIALS_FILE',
  'MODEL_BROKER_DESTINATIONS',
  'MODEL_BROKER_ROUTES',
  'MODEL_BROKER_INSTALLATION',
] as const;

/** Which provider this install's agent work runs on (LA-1). */
export const AGENT_PROVIDER_SETTING = 'OPS_AGENT_PROVIDER';
export type AgentProvider = 'api' | 'local-gpt';

export type BrokerSettings =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'configured';
      readonly provider: AgentProvider;
      readonly custody: CustodyConfig;
      readonly routes: readonly BrokerRoute[];
      readonly installation: string;
    }
  | { readonly kind: 'invalid'; readonly problem: string };

const REPLAY = {
  build: replayAdapter,
  price: replayCostMinor,
  // AW-10: the reconciliation pass asks the provider about an unknown call.
  lookup: replayLookup,
  readLookup: readReplayLookup,
};
const LOCAL_GPT = { build: localGptAdapter, price: localGptCostMinor };

const OPERATIONS = {
  api: catalogue([REPLAY_COMPOSE, CONVERSATION_ANSWER]),
  'local-gpt': catalogue([REPLAY_COMPOSE, LOCAL_GPT_COMPOSE, LOCAL_GPT_CONVERSATION]),
} as const;
const PROVIDERS = {
  api: new Map([['replay', REPLAY]]),
  'local-gpt': new Map<string, typeof REPLAY | typeof LOCAL_GPT>([
    ['replay', REPLAY],
    [LOCAL_GPT_PROVIDER, LOCAL_GPT],
  ]),
} as const;

const REACHES: ReadonlySet<string> = new Set(['local', 'cloud']);
const KINDS: ReadonlySet<string> = new Set<CredentialKind>([
  'subscription',
  'api_key',
  'cloud_credential',
  'replay',
]);
const ROUTE_TEXT = ['key', 'reach', 'provider', 'credentialRef', 'credentialKind', 'installation'];
const ROUTE_KEYS = [...ROUTE_TEXT, 'ceiling'];

const invalid = (problem: string): BrokerSettings => ({ kind: 'invalid', problem });

/** This machine, by address only (127.0.0.0/8 or [::1]), as the trace export reads it: a name can resolve anywhere. */
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|\[::1\])$/u;
const onLoopback = (origin: string): boolean => LOOPBACK.test(new URL(origin).hostname);

function parsedJson(text: string): { readonly ok: true; readonly value: unknown } | undefined {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function routeOf(entry: unknown, provider: AgentProvider): BrokerRoute | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const shape = entry as Record<string, unknown>;
  const keys = Object.keys(shape);
  if (keys.length !== ROUTE_KEYS.length || !ROUTE_KEYS.every((key) => keys.includes(key))) {
    return undefined;
  }
  // The route's ceiling across the installation (AW-01's fair share): a whole number of calls.
  const { ceiling } = shape;
  if (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling < 1) {
    return undefined;
  }
  if (!ROUTE_TEXT.every((key) => typeof shape[key] === 'string' && shape[key] !== '')) {
    return undefined;
  }
  const text = (key: string): string => shape[key] as string;
  if (!REACHES.has(text('reach')) || !KINDS.has(text('credentialKind'))) return undefined;
  if (!PROVIDERS[provider].has(text('provider'))) return undefined;
  // GPT is a cloud model wherever its runner listens: a `local` label would let the data classes through.
  if (text('provider') === LOCAL_GPT_PROVIDER && text('reach') !== 'cloud') return undefined;
  return shape as unknown as BrokerRoute;
}

/**
 * Plain http only to this machine. A call goes to its operation's
 * destination, so a local route's every operation must send to this machine
 * too, or its reach is only a label.
 */
function offMachineProblem(
  listed: ReadonlyMap<string, Destination>,
  routes: readonly BrokerRoute[],
  provider: AgentProvider,
): string | undefined {
  if (
    [...listed.values()].some(({ origin }) => origin.startsWith('http:') && !onLoopback(origin))
  ) {
    return 'MODEL_BROKER_DESTINATIONS has a plain http origin off this machine; use https';
  }
  // The GPT runner is on this machine whatever its reach says: its key must never leave it.
  const local = routes.filter(
    (route) => route.reach === 'local' || route.provider === LOCAL_GPT_PROVIDER,
  );
  const leaves = [...OPERATIONS[provider].values()].some((operation) => {
    const destination = listed.get(operation.destination);
    return (
      local.some((route) => route.provider === operation.provider) &&
      (destination === undefined || !onLoopback(destination.origin))
    );
  });
  return leaves
    ? "MODEL_BROKER_ROUTES has a local route whose destination is not this machine's loopback address"
    : undefined;
}

/** The routes setting's entries, each a route or undefined; undefined when it is not a list. */
function routesOf(
  text: string,
  provider: AgentProvider,
): readonly (BrokerRoute | undefined)[] | undefined {
  const entries = parsedJson(text)?.value;
  return Array.isArray(entries)
    ? entries.map((entry: unknown) => routeOf(entry, provider))
    : undefined;
}

const LOCAL_WITHOUT_BROKER = `${AGENT_PROVIDER_SETTING} local-gpt needs the credential broker's four settings`;

/** The install's provider, or why the setting is refused (never echoing its value). */
function agentProvider(
  environment: Readonly<Record<string, string | undefined>>,
): AgentProvider | { readonly problem: string } {
  const named = environment[AGENT_PROVIDER_SETTING] ?? '';
  if (named === '' || named === 'api') return 'api';
  if (named !== 'local-gpt') {
    return { problem: `${AGENT_PROVIDER_SETTING} is not one of api, local-gpt` };
  }
  if (environment['OPS_ENVIRONMENT'] !== 'local') {
    return {
      problem: `${AGENT_PROVIDER_SETTING} local-gpt runs only where OPS_ENVIRONMENT is local`,
    };
  }
  return 'local-gpt';
}

export function brokerSettings(
  environment: Readonly<Record<string, string | undefined>>,
): BrokerSettings {
  const provider = agentProvider(environment);
  if (typeof provider !== 'string') return invalid(provider.problem);
  const value = (name: (typeof MODEL_BROKER_SETTINGS)[number]): string => environment[name] ?? '';
  const missing = MODEL_BROKER_SETTINGS.filter((name) => value(name) === '');
  if (missing.length === MODEL_BROKER_SETTINGS.length) {
    return provider === 'api' ? { kind: 'absent' } : invalid(LOCAL_WITHOUT_BROKER);
  }
  if (missing.length > 0) {
    return invalid(`the credential broker needs all four settings; not set: ${missing.join(', ')}`);
  }

  const destinationsJson = parsedJson(value('MODEL_BROKER_DESTINATIONS'));
  const destinations =
    destinationsJson === undefined ? undefined : parseDestinations(destinationsJson.value);
  if (destinations === undefined || !destinations.ok) {
    return invalid(
      'MODEL_BROKER_DESTINATIONS is not a list of { key, origin } bare http(s) origins',
    );
  }

  const routes = routesOf(value('MODEL_BROKER_ROUTES'), provider);
  if (routes === undefined || routes.length === 0 || routes.includes(undefined)) {
    return invalid(
      'MODEL_BROKER_ROUTES is not a list of routes, each exactly { key, reach, provider, ' +
        'credentialRef, credentialKind, installation, ceiling } with a known reach, kind and ' +
        'provider and a whole-number ceiling of at least 1',
    );
  }
  const offMachine = offMachineProblem(
    destinations.destinations,
    routes as readonly BrokerRoute[],
    provider,
  );
  if (offMachine !== undefined) return invalid(offMachine);

  return {
    kind: 'configured',
    provider,
    custody: {
      credentialsFile: value('MODEL_BROKER_CREDENTIALS_FILE'),
      destinations: [...destinations.destinations.values()] as readonly Destination[],
    },
    routes: routes as readonly BrokerRoute[],
    installation: value('MODEL_BROKER_INSTALLATION'),
  };
}

/** Custody's own process, started, and the executor and the conversation exchange over it. */
export async function startModelBroker(
  settings: Extract<BrokerSettings, { kind: 'configured' }>,
): Promise<{
  readonly executor: ModelCallExecutor;
  /** AW-10: the reconciliation pass's provider phase for one business. */
  readonly reconcile: (
    database: Database,
    businessId: BusinessId,
    unanswered: Set<string>,
  ) => Promise<unknown>;
  readonly answerConversation: ConversationExchange;
  readonly stop: () => Promise<void>;
}> {
  const custody = await startCustody(settings.custody);
  const broker = {
    custody,
    operations: OPERATIONS[settings.provider],
    providers: PROVIDERS[settings.provider],
    routes: settings.routes,
    installation: settings.installation,
    localOwnerTesting: settings.provider === 'local-gpt',
  };
  return {
    executor: modelCallExecutor(broker),
    reconcile: async (database, businessId, unanswered) =>
      await reconcileProviderCalls(
        database,
        businessId,
        { ...broker, audit: callerAudit },
        unanswered,
      ),
    answerConversation: conversationExchange(broker),
    stop: async () => await custody.stop(),
  };
}
