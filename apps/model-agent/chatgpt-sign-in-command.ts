// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's one sign-in to the ChatGPT plan, run by the owner on the M5
// (`docs/local/chatgpt-plan.md`): `signIn` against OpenAI's own sign-in
// origin, pinned here, and only the outcome's name printed. It opens no
// browser: the owner opens the printed address in the laptop's browser,
// through the SSH tunnel to the printed port.
//
// `--consent-background-use` is the owner's express consent that Ops Astro
// may use the plan for runs he starts and their background steps (SIWC
// Terms s2). Without it nothing is read, written or listened on.
//
//   node apps/model-agent/chatgpt-sign-in-command.ts --consent-background-use \
//     --token-file <whole path> [--port <port>]

import { SIGN_IN_PORT, signIn } from './chatgpt-sign-in.ts';

/** OpenAI's sign-in origin: the only issuer this command signs in at. */
export const CHATGPT_SIGN_IN_ORIGIN = 'https://auth.openai.com';

function argument(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

const USAGE =
  'usage: chatgpt-sign-in-command --consent-background-use --token-file <whole path> [--port <port>]\n';

if (import.meta.main) {
  const tokenFile = argument(process.argv, '--token-file');
  const port = Number(argument(process.argv, '--port') ?? SIGN_IN_PORT);
  if (!process.argv.includes('--consent-background-use')) {
    process.stderr.write(`sign-in refused: SIGN_IN_CONSENT_NEEDED\n${USAGE}`);
    process.exitCode = 2;
  } else if (
    tokenFile?.startsWith('/') !== true ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } else {
    const result = await signIn({
      issuer: CHATGPT_SIGN_IN_ORIGIN,
      tokenFile,
      port,
      say: (line) => void process.stdout.write(`${line}\n`),
    });
    if (!result.ok) process.stderr.write(`sign-in refused: ${result.code}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
