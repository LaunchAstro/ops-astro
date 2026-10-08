// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const mode = process.env.HISTORY_BATCH_FAULT || '';
appendFileSync(process.env.HISTORY_BATCH_LOG, JSON.stringify(args) + '\n');
const batch = args.includes('--batch');
const check = args.includes('--batch-check');
const input = batch || check ? readFileSync(0) : undefined;
const result = spawnSync(process.env.HISTORY_BATCH_GIT, args, {
  input,
  maxBuffer: 64 * 1024 * 1024 + 1024,
});
if (result.error) process.exit(87);
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}
let output = result.stdout;
if (check && mode === 'check-failure') {
  process.stderr.write('planted-private-marker');
  process.exit(9);
}
if (check) {
  const lines = output.toString().trimEnd().split('\n');
  const parts = lines[0].split(' ');
  if (mode === 'check-oid') parts[0] = 'f'.repeat(parts[0].length);
  if (mode === 'check-size') parts[2] = '-1';
  if (mode === 'check-type') parts[1] = 'unexpected';
  if (mode === 'typed-fallback') parts[1] = parts[1] === 'commit' ? 'tag' : 'tree';
  lines[0] = parts.join(' ');
  output = Buffer.from(lines.join('\n') + '\n');
  if (mode === 'check-missing') output = Buffer.from(parts[0] + ' missing\n');
  if (mode === 'check-extra') output = Buffer.concat([output, Buffer.from('surplus\n')]);
}
if (batch) {
  const end = output.indexOf(10);
  const parts = output.subarray(0, end).toString().split(' ');
  const size = Number(parts[2]);
  if (mode === 'batch-oid') parts[0] = 'f'.repeat(parts[0].length);
  if (mode === 'batch-type') parts[1] = parts[1] === 'blob' ? 'commit' : 'blob';
  if (mode === 'batch-size') parts[2] = String(size + 1);
  if (['batch-oid', 'batch-type', 'batch-size'].includes(mode))
    output = Buffer.concat([Buffer.from(parts.join(' ') + '\n'), output.subarray(end + 1)]);
  if (mode === 'batch-truncated') output = output.subarray(0, end + size);
  if (mode === 'batch-delimiter') output[end + 1 + size] = 0;
  if (mode === 'batch-missing') output = Buffer.alloc(0);
  if (mode === 'batch-extra') output = Buffer.concat([output, Buffer.from('surplus')]);
  if (mode === 'batch-failure') {
    process.stderr.write('planted-private-marker');
    process.exit(9);
  }
}
process.stdout.write(output);
