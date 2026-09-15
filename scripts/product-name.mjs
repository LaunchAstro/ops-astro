// SPDX-License-Identifier: AGPL-3.0-only
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const targets = [
  { file: 'README.md', prefix: '# ' },
  { file: 'NOTICE', prefix: '' },
];

function plainName(name) {
  return (
    typeof name === 'string' &&
    name === name.trim() &&
    /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .'’-]*$/u.test(name)
  );
}

function readTarget({ file, prefix }, name, write) {
  const path = resolve(root, file);
  if (!lstatSync(path).isFile()) throw new Error(`${file} must be a regular file, not a link`);
  const fd = openSync(path, (write ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${file} must be a regular file`);
    const bytes = readFileSync(fd);
    const newline = bytes.indexOf(10);
    const end = newline < 0 ? bytes.length : newline - (bytes[newline - 1] === 13 ? 1 : 0);
    const heading = bytes.subarray(0, end).toString('utf8');
    if (!heading.startsWith(prefix) || !plainName(heading.slice(prefix.length))) {
      throw new Error(`${file} needs a plain product name on its first line`);
    }
    const next = Buffer.concat([Buffer.from(prefix + name), bytes.subarray(end)]);
    return { file, fd, next, changed: !bytes.equals(next) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--check', '--write'].includes(args[0]))) {
    throw new Error('usage: node scripts/product-name.mjs [--check | --write]');
  }
  const write = args[0] === '--write';
  const source = readFileSync(resolve(root, 'product.json'), 'utf8');
  if (!/^\s*\{\s*"name"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/u.test(source)) {
    throw new Error('product.json must contain exactly one literal "name" string member');
  }
  const metadata = JSON.parse(source);
  if (!plainName(metadata.name)) {
    throw new Error('product.json must contain only a trimmed, single-line plain name');
  }

  const files = [];
  try {
    for (const target of targets) files.push(readTarget(target, metadata.name, write));
    const changed = files.filter((file) => file.changed);
    if (!write && changed.length > 0) {
      console.error(
        `product-name: headings differ in ${changed.map((file) => file.file).join(', ')}`,
      );
      console.error('product-name: run pnpm brand:sync to update the two headings');
      process.exitCode = 1;
      return;
    }
    for (const { fd, next } of changed) {
      let offset = 0;
      while (offset < next.length) {
        const written = writeSync(fd, next, offset, next.length - offset, offset);
        if (written === 0) throw new Error('heading update made no progress');
        offset += written;
      }
      ftruncateSync(fd, next.length);
    }
    console.log(
      `product-name: ${write ? changed.length + ' heading(s) updated; ' : ''}headings match`,
    );
  } finally {
    for (const { fd } of files) closeSync(fd);
  }
}

try {
  main();
} catch (error) {
  console.error(`product-name: ${error.message}`);
  process.exitCode = 2;
}
