# The side panel on Ollama (the M5)

<!-- SPDX-License-Identifier: AGPL-3.0-only -->

The agent side panel can answer from a model Ollama runs on the same machine
as the API: Qwen (`qwen3.6:27b-mlx`, the default) or Gemma
(`gemma4:31b-mlx`), picked per conversation. It costs nothing per message.
The answer shows word by word as Ollama writes it, then settles.
Where the API and Ollama share a machine, custody sends to Ollama directly.
On the hosted sites, whose API runs on Vercel, the answer is carried to the
M5's model agent over Supabase Realtime (below).

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

## On the hosted sites: carried to the M5

The hosted API holds no Ollama credential and no destination. Each call goes
to the M5's model agent over Supabase Realtime, and the agent's own custody
sends it to Ollama on loopback. Neither side listens on a port: both connect
out to Supabase.

1. The model agent ("M5 models") is an agent actor of the business with its
   own login, made by the operator scripts as the M5 worker's is. Its
   process on the M5 is installed as [model-agent.md](model-agent.md) says.
2. Start the hosted API with these settings, and without
   `MODEL_BROKER_CREDENTIALS_FILE` or `MODEL_BROKER_DESTINATIONS` (either one
   stops it):

   ```sh
   OPS_AGENT_PROVIDER=ollama
   MODEL_BROKER_CARRIER='{"agent":"<agent actor id>","people":["<person id>"]}'
   MODEL_BROKER_ROUTES='[{"key":"m5_ollama","reach":"local","provider":"ollama","credentialRef":"carried","credentialKind":"api_key","installation":"<install>","ceiling":2}]'
   MODEL_BROKER_INSTALLATION=<install>
   MODEL_BROKER_CARRY_KEY=<32 random bytes or more, base64url>
   SUPABASE_REALTIME_URL=wss://<project>.supabase.co/realtime/v1
   SUPABASE_PUBLISHABLE_KEY=<the project's publishable key>
   ```

   Ids are lower case. The agent holds the same carry key. To rotate it, set
   the new key as `MODEL_BROKER_CARRY_KEY_NEXT` on both sides, then make it
   the current key on both and unset the next one.

3. Add Supabase Realtime to the overseas-services register: it carries
   internal chat text in transit, the question and the answer's words, and
   the database stores only id-only doorbells.

How one message travels:

- The function joins the call's private line with the person's own token,
  and the database rings the agent's doorbell with ids only.
- The agent accepts. The function judges the call again (the person's grant
  and session, the conversation, its page task, the agent's membership) and
  holds that judgement until the agent reports the request written to
  Ollama, or 3 seconds after the accept. A revocation or a client link in
  that time waits for the write, never the other way round.
- Words come back as provisional pieces; the sealed answer settles at
  nothing. Every message on the line is sealed with the carry key, so a
  person who joins their own call's line cannot write as the agent.
- No accept within 5 seconds: the answer says the machine is away, and
  nothing was sent. A call whose request may have gone and then fell silent
  is held at nothing, never released.

Only the people on `MODEL_BROKER_CARRIER` are carried, and the agent joins a
conversation only when its owner picks a model the agent carries. A client's
conversation is never carried.

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
