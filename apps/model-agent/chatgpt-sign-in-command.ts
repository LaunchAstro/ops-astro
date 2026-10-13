// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's one sign-in to the ChatGPT plan, as a command on the M5
// (`docs/local/chatgpt-plan.md`): `signIn` against the plan's own sign-in
// address, the browser opened with macOS `open`, and only the outcome's name
// printed.
//
//   node apps/model-agent/chatgpt-sign-in-command.ts --client-id <id> --token-file <path>

import { spawn } from 'node:child_process';
import { signIn } from './chatgpt-sign-in.ts';
import { CHATGPT_SIGN_IN_ORIGIN } from './settings.ts';

/** `--name value` pairs from the command line. */
function argument(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

if (import.meta.main) {
  const clientId = argument(process.argv, '--client-id');
  const tokenFile = argument(process.argv, '--token-file');
  if (clientId === undefined || tokenFile === undefined || !tokenFile.startsWith('/')) {
    process.stderr.write('usage: chatgpt-sign-in --client-id <id> --token-file <whole path>\n');
    process.exitCode = 2;
  } else {
    const result = await signIn({
      issuer: CHATGPT_SIGN_IN_ORIGIN,
      clientId,
      tokenFile,
      open: (address) => void spawn('open', [address], { stdio: 'ignore' }).on('error', () => {}),
      say: (line) => void process.stdout.write(`${line}\n`),
    });
    if (!result.ok) process.stderr.write(`sign-in refused: ${result.code}\n`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
