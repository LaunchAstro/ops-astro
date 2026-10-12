# The side panel on Ollama (the M5)

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The agent side panel can answer from a model Ollama runs on the same machine
as the API: Qwen (`qwen3.6:27b-mlx`, the default) or Gemma
(`gemma4:31b-mlx`), picked per conversation. It costs nothing per message.
It works only where the API and Ollama share a machine, so it is not on the
hosted sites, whose API runs on Vercel.

## Switch it on

1. Ollama runs on the machine and has both models (`ollama list`). Its port
   stays on loopback; never publish it.
2. File a credential for custody in a file only you can read. Ollama asks for
   no key, so the value is any random local token:

   ```json
   [
     {
       "ref": "ollama_key",
       "kind": "api_key",
       "account": "m5-ollama",
       "destination": "ollama",
       "header": "authorization",
       "value": "<random>"
     }
   ]
   ```

3. Start the API with these settings:

   ```sh
   OPS_AGENT_PROVIDER=ollama
   MODEL_BROKER_CREDENTIALS_FILE=<that file>
   MODEL_BROKER_DESTINATIONS='[{"key":"ollama","origin":"http://127.0.0.1:11434"}]'
   MODEL_BROKER_ROUTES='[{"key":"m5_ollama","reach":"local","provider":"ollama","credentialRef":"ollama_key","credentialKind":"api_key","installation":"<install>","ceiling":2}]'
   MODEL_BROKER_INSTALLATION=<install>
   ```

## What it refuses

- An Ollama route that is not `local`, or a destination that is not this
  machine's loopback address: the API does not start.
- **Chat about a client.** No client's conversation is offered either model,
  whatever the client's model setting says. Ollama is for internal work only.
- A model Ollama does not have answers in fixed words, and nothing is kept.

## What the agent can do

It answers in words only. When asked to write a task, or to change the task
the chat is open on, it ends its reply with a task block. The side panel shows
that block as a card, and only your click on the card creates or changes the
task. A first answer can take a minute while Ollama loads the model.
