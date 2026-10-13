# The model agent on the M5

The hosted sites carry side-panel chats to Ollama on the M5 through the model
agent (`apps/model-agent/`), an agent actor of the business with its own
login. [OLLAMA.md](OLLAMA.md) covers the hosted half. This page installs the
M5 half. It is a new process on the M5, beside the worker.

The agent connects out only: one socket to Supabase Realtime and HTTPS for
its sign-in. Nothing on the M5 listens beyond Ollama on loopback. The agent
holds no database privilege and no provider secret: custody, its child
process, holds Ollama's credential filed as `none`.

## What it does with a call

1. The database rings the agent's doorbell with ids when a call of a
   conversation it belongs to is offered. The agent joins that call's line
   and accepts, stamping the accept with its own clock.
2. It runs only a request sealed by the hosted API for that call and that
   process, and only a streamed chat with an offered model to `/api/chat`.
   It runs each call once; a repeat is ignored or answered with the same
   last word.
3. Custody writes the request to Ollama only within 3 seconds of the
   accept, on the M5's clock. Past that, nothing is written and the call is
   refused `SEND_LAPSED`.
4. Above a one-minute load of 45 it refuses `MODEL_MACHINE_BUSY` before
   custody.
5. Words go back as pieces of display text, never Ollama's thinking. The
   sealed answer is sent again every 2 seconds until the hosted API says it
   settled, three times at most.

Its log names what happened (`offer`, `accept`, `started`, `written`,
`answer`), never ids or chat text.

## Install

1. Make the agent actor and its login with the operator scripts, as for the
   M5 worker. Keep the password in Bitwarden.
2. Write custody's credential file, mode 600:

   ```json
   [
     {
       "ref": "ollama_key",
       "kind": "api_key",
       "account": "m5-ollama",
       "destination": "ollama",
       "scheme": "none"
     }
   ]
   ```

3. Write the settings file, mode 600. Ids are lower case. The carry key is
   the one the hosted API holds as `MODEL_BROKER_CARRY_KEY`.

   ```json
   {
     "business": "<business id>",
     "agent": "<agent actor id>",
     "gotrueUrl": "https://<project>.supabase.co/auth/v1",
     "email": "<agent login>",
     "password": "<agent password>",
     "providerKey": "<the project's publishable key>",
     "realtimeUrl": "wss://<project>.supabase.co/realtime/v1",
     "carryKey": "<carry key>",
     "ollamaOrigin": "http://127.0.0.1:11434",
     "credentialsFile": "<credential file path>",
     "credentialRef": "ollama_key"
   }
   ```

   The agent refuses to start when anyone but its owner can read this file,
   or when `ollamaOrigin` is not this machine's loopback.

4. Run the install check, then load the job:

   ```sh
   scripts/m5/model-agent-install-check.sh <settings file> <credential file>
   ```

   Fill the `@…@` values in `deploy/m5/ops-astro-model-agent.plist`, copy
   it to `~/Library/LaunchAgents/`, and `launchctl load` it. launchd keeps it
   running and starts it again if it, or its custody, stops.

## Rotating the carry key

Add the new key as `carryKeyNext` here and as `MODEL_BROKER_CARRY_KEY_NEXT`
on the hosted API, restart both, then make it the current key on both,
remove the next one, and restart again. Either key opens a message while
both are set.
