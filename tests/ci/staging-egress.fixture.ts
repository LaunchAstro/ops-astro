// SPDX-License-Identifier: AGPL-3.0-only
//
// The hello a TLS client sends first, built by hand for the egress relay's cases
// (tests/ci/staging-egress.test.ts): only its server name matters to the relay.

/** A TLS 1.3 ClientHello carrying `name` as its server name, as a client sends it. */
export function hello(name: string): Buffer {
  const host = Buffer.from(name, 'latin1');
  const sni = Buffer.concat([
    Buffer.from([0, 0]),
    u16(host.length + 5),
    u16(host.length + 3),
    Buffer.from([0]),
    u16(host.length),
    host,
  ]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(sni.length),
    sni,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(handshake.length), handshake]);
}
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

/** On staging: connect, send `B` (hex), print the first answer or nothing. */
export const ASK_SCRIPT =
  "const s=require('net').connect(+process.env.P,process.env.H,()=>s.write(Buffer.from(process.env.B,'hex')));let o='';s.on('data',d=>{console.log('got:'+d);process.exit(0)});s.on('close',()=>{console.log('got:'+o);process.exit(0)});s.on('error',()=>{console.log('got:');process.exit(0)});setTimeout(()=>{console.log('got:'+o);process.exit(0)},8000)";

/** A stand-in for one place: answers each chunk with its own name. */
export const STAND_SCRIPT =
  "require('net').createServer(s=>s.on('data',()=>s.write('from-'+process.env.N))).listen(+process.env.P)";

/** On staging: through the pooler's relay, speak, idle past the first-bytes limit, speak again. */
export const IDLE_SCRIPT =
  "const s=require('net').connect(6543,'pooler.example.test',()=>s.write('a'));let n=0;s.on('data',()=>{n+=1;if(n===1)setTimeout(()=>s.write('b'),12000);else{console.log('twice');process.exit(0)}});s.on('close',()=>{console.log('closed after '+n);process.exit(0)})";
