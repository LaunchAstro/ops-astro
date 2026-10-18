// SPDX-License-Identifier: AGPL-3.0-only
import { once } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tokenHolder } from '../../../packages/core-custody/src/plan-token.ts';
const { file, ready, release, done, at } = JSON.parse(process.argv[2]!);
const server = createServer(async (req, res) => {
  req.resume();
  await once(req, 'end');
  writeFileSync(ready, 'refresh in flight');
  while (!existsSync(release))
    // oxlint-disable-next-line no-await-in-loop -- polls for the parent's release file
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      access_token: 'synthetic-access-winner',
      refresh_token: 'synthetic-refresh-winner',
      expires_in: 3600,
    }),
  );
});
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});
const port = (server.address() as { port: number }).port;
const holder = tokenHolder({
  file,
  tokenUrl: new URL(`http://127.0.0.1:${port}/token`),
  now: () => at,
});
const result = await holder.prepare();
writeFileSync(done, JSON.stringify({ result, present: holder.present() }));
server.closeAllConnections();
await new Promise<void>((resolve) => {
  server.close(() => resolve());
});
