# The owner's ChatGPT plan on the M5

The first agent run uses the owner's own ChatGPT plan, through Sign in with
ChatGPT on the M5 (#1620). The plan's token is made on the M5 and stays there:
custody holds it, refreshes it and presents it. It never reaches the laptop,
the hosted site, Git, chat or a log.

This page is the owner's one-time sign-in checklist (#1705). Only the owner
runs it, and only on the M5. No agent runs any step here.

## The plan's route

The model agent sends a plan call (`chatgpt_plan`) only when its settings name
all three of `planTokenFile` (this sign-in's token file, by absolute path),
`planOrigin` (exactly `https://api.openai.com`) and `planIssuer` (exactly
`https://auth.openai.com`). Without them it refuses every plan request and
sends nothing ([model agent](model-agent.md)).

- It carries only runs the owner started; any other is refused
  `SUBSCRIPTION_NOT_OWNER_STARTED`, and the call is recorded as a
  `subscription` call.
- Its body is only Responses' `model`, `instructions`, `input`, optional
  strict function `tools`, `store: false` and `stream: true`.
- An offer names no route, so with the plan set the agent asks custody to
  make the token ready before every accept, for up to 30 seconds. A plan
  call waits up to 35 seconds for its accept. Any other call still waits 5,
  so an Ollama call that comes while a refresh runs past 5 seconds is
  released `MODEL_MACHINE_AWAY`, with nothing sent.
- Custody sends the token only to `https://api.openai.com`. It never reaches
  the agent, the hosted site or a log, and it is never filed as a credential.

## How the sign-in works

- It is OpenAI's open-source token-sharing flow
  (<https://developers.openai.com/siwc/token-sharing-open-source/sign-in>):
  a browser approval that returns to a loopback address on the M5,
  `http://127.0.0.1:<port>/auth/callback`, with the scopes `openid profile
email offline_access resource.invoke chatgpt.tokens.use.direct` and the
  resource `https://api.openai.com/v1`. Only the port may vary.
- There is no device code for this flow. The M5 has no screen, so the browser
  runs on the laptop and reaches the M5's port through an SSH tunnel. The code
  exchange and the token file happen on the M5 only.
- The first sign-in registers Ops Astro with the ChatGPT account. OpenAI
  issues a client id during it, which is kept in `chatgpt-host.json` beside
  the token file with this machine's host id. Neither is a secret.
- The command checks the ID token (its signature, issuer, client, expiry and
  nonce) and that the grant includes plan use before it stores anything. Only
  a record custody can read back counts as signed in.
- Codex's own login (`~/.codex/auth.json`, used by the local agent) is a
  different client. Nothing here reads it, and it must never stand in for this
  sign-in. Do not use OpenAI's "self-hosted VM" import either: it puts the
  tokens on the laptop first.

## Before you start

1. **Choose the plan.** Sign in with a personal ChatGPT Plus or Pro account.
   OpenAI's docs name only those two. A Business workspace may answer 403.
   Pro is recommended: on Plus, the five-hour limit is shared with every other
   app on the account, Codex included.
2. **Give your consent for background use.** Ops Astro uses the plan only
   for runs you start, and for the background steps of those runs. OpenAI's
   Sign in with ChatGPT Terms (s2) need your express consent before any
   background use. The command will not start without the flag
   `--consent-background-use`, which is that consent. Record it once on #1705
   with this line, filled in:

   > I, the owner, consent to Ops Astro using my ChatGPT plan (Plus or Pro)
   > on the M5 for runs I start and their background steps. Date: ...

3. **Make the token folder, yours only, outside any repository:**

   ```sh
   mkdir -p ~/.ops-astro && chmod 700 ~/.ops-astro
   ```

4. **Keep it out of Time Machine** before the first sign-in. A backup copy is
   a live refresh token outside this folder.

   ```sh
   tmutil addexclusion ~/.ops-astro
   tmutil isexcluded ~/.ops-astro
   ```

   The second command must answer `[Excluded]`.

5. **Check no folder above it is writable by anyone else.** Custody checks
   the token folder itself, not the folders above it.

   ```sh
   d=~/.ops-astro; while [ "$d" != / ]; do d=$(dirname "$d"); ls -lde "$d"; done
   ```

   Every line must be owned by you or by `root`, show no `w` in the group or
   other columns (the 6th and 9th characters), and list no ACL entry that
   grants `write` or `add_file`. If one fails, stop and tell the orchestrator.

6. **Check the port is free.** The sign-in uses port 1455 unless you pass
   `--port`. A running `codex login` holds 1455 on either machine. If
   `lsof -nP -iTCP:1455` on the M5 or the laptop shows anything, finish or
   stop that first, or use another port, say 1457, in both places:
   `ssh -L 127.0.0.1:1457:127.0.0.1:1457 <m5>`, and `--port 1457` on the
   command.

## Sign in once (SSH tunnel, recommended)

1. On the laptop, open a terminal and connect to the M5 with the tunnel:

   ```sh
   ssh -L 127.0.0.1:1455:127.0.0.1:1455 <m5>
   ```

2. In that SSH session, from the ops-astro checkout on the M5, run:

   ```sh
   node apps/model-agent/chatgpt-sign-in-command.ts --consent-background-use \
     --token-file "$HOME/.ops-astro/chatgpt-plan.json"
   ```

3. It prints an address starting `https://auth.openai.com/api/accounts/authorize`.
   Open it in the laptop's browser. Sign in with the plan's account. ChatGPT
   asks you to name the agent (it suggests `Ops Astro`) and to approve its
   use of your plan. Approve. The page then says you can close the tab.
4. The terminal says `Signed in.`, or `sign-in refused:` and a name (below).
5. Check the file is yours only: `ls -l ~/.ops-astro/chatgpt-plan.json` shows
   `-rw-------`.
6. Close the SSH session.

**Fallback: Screen Sharing.** If the tunnel won't work, open Screen Sharing to
the M5, run step 2 in Terminal there, and open the printed address in the
M5's own browser.

## What a refusal means

| Refusal                                                                                                     | What to do                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGN_IN_CONSENT_NEEDED`                                                                                    | Add `--consent-background-use` (step 2 of "Before you start").                                                                                                                                                    |
| `SIGN_IN_PORT_BUSY`                                                                                         | Something holds the port. See step 6 of "Before you start".                                                                                                                                                       |
| `SIGN_IN_DECLINED`                                                                                          | The approval was declined, or plan use isn't enabled on the account. Enable it, run again.                                                                                                                        |
| `SIGN_IN_PLAN_USE_NOT_GRANTED`                                                                              | The grant didn't include plan use. Check the plan (Plus or Pro), run again.                                                                                                                                       |
| `SIGN_IN_IDENTITY_INVALID`                                                                                  | The ID token didn't check out. Nothing was stored. Tell the orchestrator; don't keep retrying.                                                                                                                    |
| `SIGN_IN_ACCOUNT_CHANGED`                                                                                   | Another ChatGPT account than the stored one. To switch accounts, see "Rules".                                                                                                                                     |
| `SIGN_IN_REGISTRATION_CHANGED`                                                                              | Another sign-in registered meanwhile, or the two files name different registrations. Run again; if it repeats, remove both files (below).                                                                         |
| `SIGN_IN_FILE_NEEDS_OWNER`                                                                                  | The token file is unreadable, open to others, or half-written. Remove it (below), run again.                                                                                                                      |
| `SIGN_IN_HOST_FILE_NEEDS_OWNER`                                                                             | `chatgpt-host.json` is unreadable or open to others. Remove both files (below), run again (this registers).                                                                                                       |
| `SIGN_IN_TOKENS_UNUSABLE`                                                                                   | OpenAI returned values custody can't store. Nothing was stored. Tell the orchestrator.                                                                                                                            |
| `SIGN_IN_STORE_FAILED`                                                                                      | The write failed and the new tokens were removed, unless the lock was lost mid-write. Check disk space, run again. If the next sign-in says `SIGN_IN_FILE_NEEDS_OWNER`, the lock was lost: remove the token file. |
| `SIGN_IN_STATE_MISMATCH`, `SIGN_IN_REGISTRATION_INCOMPLETE`, `SIGN_IN_EXCHANGE_FAILED`, `SIGN_IN_TIMED_OUT` | Run again from step 2.                                                                                                                                                                                            |

To remove the token file custody refuses: `rm ~/.ops-astro/chatgpt-plan.json`.
To remove both files: `rm ~/.ops-astro/chatgpt-plan.json ~/.ops-astro/chatgpt-host.json`.
Don't copy either anywhere first.

## What to record on #1705

Paste only these, never a token, a code, the authorise address or a file's
contents:

- the plan (Plus or Pro) and the consent line above;
- the output of `tmutil isexcluded ~/.ops-astro`;
- that every ancestor line passed (or which failed);
- the output of `ls -l ~/.ops-astro/chatgpt-plan.json`;
- `Signed in.` or the refusal's name.

## Rules

- No one but the owner runs these steps, and only on the M5.
- Never paste a token, a code or the token file into chat, a ticket, a file in
  Git or a note.
- Nothing reads or reuses another ChatGPT or Codex login on either machine.
- To switch to another ChatGPT account later, remove both
  `~/.ops-astro/chatgpt-plan.json` and `~/.ops-astro/chatgpt-host.json`, then
  sign in again; it registers Ops Astro with that account.
- After any restore or copy of `~/.ops-astro`, sign in again.
- An M5 left idle for 30 days needs a fresh sign-in.
