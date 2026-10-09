// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';

const historyMaxBuffer = 64 * 1024 * 1024;

function invalidHistoryObject() {
  throw Object.assign(new Error('history object validation failed'), {
    code: 'HISTORY_OBJECT_INVALID',
  });
}

function historyObjectHeader(bytes) {
  const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (blob|commit|tree|tag) (0|[1-9][0-9]*)$/u.exec(
    bytes.toString(),
  );
  if (!match) invalidHistoryObject();
  return { oid: match[1], type: match[2], size: BigInt(match[3]) };
}

function readHistoryBatch(git, requests, type) {
  const output = git(
    ['cat-file', '--batch'],
    Buffer.from(requests.map(({ oid }) => `${oid}\n`).join('')),
  );
  const objects = new Map();
  let offset = 0;
  for (const request of requests) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) invalidHistoryObject();
    const header = historyObjectHeader(output.subarray(offset, newline));
    if (header.oid !== request.oid || header.type !== type || header.size !== request.size)
      invalidHistoryObject();
    const start = newline + 1;
    const end = start + Number(header.size);
    if (end >= output.length || output[end] !== 10) invalidHistoryObject();
    objects.set(request.oid, Buffer.from(output.subarray(start, end)));
    offset = end + 1;
  }
  if (offset !== output.length) invalidHistoryObject();
  return objects;
}

function historicalObjects(git, oids, type) {
  const objects = new Map();
  for (let at = 0; at < oids.length; at += 256) {
    const requested = oids.slice(at, at + 256);
    const lines = git(
      ['cat-file', '--batch-check'],
      Buffer.from(requested.map((oid) => `${oid}\n`).join('')),
    )
      .toString()
      .split('\n');
    if (lines.length !== requested.length + 1 || lines.pop() !== '') invalidHistoryObject();
    const checked = lines.map((line, i) => {
      const header = historyObjectHeader(Buffer.from(line));
      if (header.oid !== requested[i]) invalidHistoryObject();
      return header;
    });
    let pending = [];
    let size = 0n;
    const flush = () => {
      if (pending.length > 0) {
        for (const [oid, bytes] of readHistoryBatch(git, pending, type)) objects.set(oid, bytes);
      }
      pending = [];
      size = 0n;
    };
    for (const object of checked) {
      const framed =
        object.size +
        BigInt(Buffer.byteLength(`${object.oid} ${object.type} ${object.size}\n`) + 1);
      if (object.type !== type || framed > BigInt(historyMaxBuffer)) {
        flush();
        // Typed cat-file retains Git's dereferencing and original payload ceiling.
        objects.set(object.oid, git(['cat-file', type, object.oid]));
        continue;
      }
      if (size + framed > BigInt(historyMaxBuffer)) flush();
      pending.push(object);
      size += framed;
    }
    flush();
  }
  return objects;
}

export function historyReader(repository) {
  const git = (args, input) =>
    execFileSync('git', ['--no-replace-objects', '-C', repository, ...args], {
      stdio: 'pipe',
      input,
      maxBuffer: historyMaxBuffer,
    });
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false') {
    throw new Error('history policy requires a complete Git checkout');
  }
  return { git, objects: (oids, type) => historicalObjects(git, oids, type) };
}
