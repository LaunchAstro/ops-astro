# The GPT runner on the M5

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The side panel's GPT answers on the owner's ChatGPT plan come from the local
runner (`apps/local-agent`, [the local agent](LOCAL-AGENT.md)), run on the M5
as a LaunchAgent of the M5's own user. It is internal work only: the owner's
own messages, never a client's conversation. Nothing it does costs money: the
plan is already paid for. Design: `designs/chat-gpt-subscription.md` rev2 in
the roadmap round folder.

## What it keeps where

- **The ChatGPT sign-in** lives in the runner's own Codex home,
  `<home>/codex`, and nowhere else: not in a vault, custody, chat or Git.
  Codex writes and refreshes it itself. If it is lost, sign in again.
- **The runner's key** guards its loopback door. The install makes it, and it
  is in two files on the M5, both 0600: the runner's settings file and
  custody's credential file. It is in no vault: a reinstall makes a new one.
- **The plist** (`deploy/m5/ops-astro-gpt-runner.plist`) names the settings
  file (`OPS_LOCAL_AGENT_SETTINGS`) and holds no setting's value, since others on
  the machine can read a plist.
- Same-user residual: any process of the M5's user could read the Codex home's
  sign-in. A dedicated macOS user is the hardening step if it is wanted.

## The settings file

A JSON object of the runner's own settings, each a string, readable by its
owner alone (`chmod 600`):

```json
{
  "OPS_LOCAL_AGENT_SITE": "m5",
  "OPS_LOCAL_AGENT_CODEX_VERSION": "0.162.1",
  "OPS_LOCAL_AGENT_HOME": "/Users/<m5 user>/.config/ops-astro-gpt-runner",
  "OPS_LOCAL_AGENT_PORT": "<port>",
  "OPS_LOCAL_AGENT_CODEX_BIN": "<the pinned codex's absolute path>",
  "OPS_LOCAL_AGENT_KEY": "<the runner's key>"
}
```

The runner refuses the file (`SETTINGS_REFUSED`) when others can open it,
when a link stands in its place, or when it holds a setting the runner does not
take or a value that is not text. It also refuses a setting given both there
and in the environment. A refusal names a setting, never a value.

## Install

1. Make the runner's home and Codex home, both 0700:
   `mkdir -p -m 700 ~/.config/ops-astro-gpt-runner/codex`.
2. **The owner signs it in, once** (about 2 minutes). Run
   `CODEX_HOME=~/.config/ops-astro-gpt-runner/codex <codex> login --device-auth`
   on the M5, where `<codex>` is the binary the settings name, then approve the code it shows in a browser signed in to
   ChatGPT. This is never a copy of another Codex home's login: two copies of
   one sign-in sign each other out.
3. Make the runner's key, a random token (`openssl rand -hex 24`, as the
   laptop's stack makes one), never a chosen word. Write the settings file, and
   file the same key in custody's credential file for destination `local_gpt`
   (both 0600).
4. Run `scripts/m5/gpt-runner-install-check.sh <settings file> <credential file>`
   on the files the plist and custody will name. It passes only when:
   - the runner's own loader takes the settings file as it stands, alone;
   - the settings are the M5 site's, with the Codex version pinned, and name
     the runner home and the Codex binary by plain absolute paths;
   - both homes are private; neither they nor the child's working folder hold
     `AGENTS.md`, `AGENTS.override.md` or `config.toml`, before Codex runs or
     after; and no git checkout holds the runner home;
   - that binary says it is the pinned version and is signed in to the
     ChatGPT plan;
   - the credential file is a regular 0600 file of this user, and no access
     list lets others into either file or either home;
   - custody itself would load the credential file (its own parser), and it
     holds the runner's key, and only it, for the door;
   - the settings fix the runner's port, the one custody's `local_gpt`
     destination names, and a runner already listening there listens on
     loopback alone. When `lsof` is
     missing or fails, the check fails: it never reads that as no listener.
     When it sees none, the check binds the port on loopback as the runner
     will, since `lsof` cannot see another user's listener.

   It prints a kind, never a value. `signed_out` means step 2 is owed.

5. Fill the plist's placeholders and load it with `launchctl bootstrap gui/<uid>`.
6. **Live control, once.** One `codex exec --json` call on the pinned version
   records that `exec` gives no text before `item.completed`. That is why
   streamed calls use the app-server. The install's live checks also record
   the time from request to `sent`, and whether the plan reports
   `ordinaryUsageAllowed` and a weekly window. Without them every streamed call
   is `GPT_USAGE_UNKNOWN`.

## Switching account

`codex logout`, then step 2 with the other ChatGPT account, in the same Codex
home. No code or setting changes. The 95% weekly stop then reads that account.

## When it is signed out

A streamed call answers `GPT_SIGNED_OUT` and asks the model nothing; the panel
says so, and no other model is tried. The install check says `signed_out`. Sign
in again (step 2).
