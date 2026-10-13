# The side panel on Ollama (the M5)

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The agent side panel can answer from a model Ollama runs on the same machine
as the API: Qwen (`qwen3.6:27b-mlx`, the default) or Gemma
(`gemma4:31b-mlx`), picked per conversation. It costs nothing per message.
The answer shows word by word as Ollama writes it, then settles.
It works only where the API and Ollama share a machine, so it is not on the
hosted sites, whose API runs on Vercel.

## Switch it on

1. Ollama runs on the machine and has both models (`ollama list`). Its port
   stays on loopback; never publish it.
2. File a credential for custody in a file only you can read. Ollama asks for
   no key, so the credential is filed as `none`, with no header and no value,
   and custody sends no credential header at all:

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

   A credential filed the old way, with a random local token, still works,
   but the answer then comes whole at the end rather than word by word:
   custody passes an answer on as it arrives only when it presented nothing
   the answer could echo.

3. Start the API with these settings:

   ```sh
   OPS_AGENT_PROVIDER=ollama
   MODEL_BROKER_CREDENTIALS_FILE=<that file>
   MODEL_BROKER_DESTINATIONS='[{"key":"ollama","origin":"http://127.0.0.1:11434"}]'
   MODEL_BROKER_ROUTES='[{"key":"m5_ollama","reach":"local","provider":"ollama","credentialRef":"ollama_key","credentialKind":"api_key","installation":"<install>","ceiling":2}]'
   MODEL_BROKER_INSTALLATION=<install>
   ```

## How the answer streams

The adapter asks Ollama for a streamed chat. Custody passes each chunk on to
the API as it arrives, and the API reads it with the Ollama adapter's piece
reader: whole lines only, the reply's words, and a leading thinking block
never shown. The side panel asks for the answer as an event stream and shows
the words as one provisional line. The settled answer is the whole stream
folded back into one answer and read as before; only it is kept. A stream
that breaks off keeps nothing, and the panel says the answer did not finish.

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
