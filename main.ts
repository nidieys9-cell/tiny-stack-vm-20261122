// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA v1. Semantics follow ISA.md;
// where it could be read two ways, the kit's reference VM vm.mjs is the rule.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Opcode table, indexed by opcode byte: immediate length (-1 = no opcode),
// values popped, values pushed. Encoded as "OOIPP" per opcode: OO = opcode
// byte in hex, I = immediate bytes, P = pops, P = pushes.
const IM = new Int8Array(256).fill(-1);
const PO = new Int8Array(256);
const PU = new Int8Array(256);
for (const e of (
  '00000,01101,02401,03010,04012,05022,06023,07033,' +
  '10021,11021,12021,13021,14021,15021,16021,17011,18021,19021,1a021,1b011,' +
  '1c021,1d021,1e021,20021,21021,22021,30200,31210,32210,33200,34000,' +
  '40011,41020,50010,51010,52001,53010'
).split(',')) {
  const o = parseInt(e.slice(0, 2), 16);
  IM[o] = +e[2];
  PO[o] = +e[3];
  PU[o] = +e[4];
}

function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; len: number; exit: number } {
  const n = p.length;
  const S = new Int32Array(256);
  let sp = 0;
  const C = new Int32Array(64);
  let cp = 0;
  const M = new Int32Array(256);
  const o = new Uint8Array(65536);
  let ol = 0;
  let ip = 0;
  let pc = 0;
  let st = 0;
  const R = (e: number) => ({ out: o, len: ol, exit: e });
  for (;;) {
    if (st === 1000000) return R(10); // step limit
    if (pc < 0 || pc >= n) return R(9); // pc outside program
    const op = p[pc];
    const im = IM[op];
    if (im < 0) return R(5); // unknown opcode
    if (pc + im >= n) return R(9); // immediate cut off
    st++;
    const nx = pc + 1 + im;
    const pops = PO[op];
    if (sp < pops) return R(2); // underflow
    if (sp - pops + PU[op] > 256) return R(3); // overflow
    pc = nx;
    switch (op) {
      case 0x00:
        return R(0); // HALT
      case 0x01:
        S[sp++] = (p[nx - 1] << 24) >> 24; // PUSH8, sign-extended
        break;
      case 0x02: // PUSH32, little-endian
        S[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 0x03:
        sp--; // POP
        break;
      case 0x04:
        S[sp] = S[sp - 1]; sp++; // DUP
        break;
      case 0x05: { // SWAP
        const t = S[sp - 1]; S[sp - 1] = S[sp - 2]; S[sp - 2] = t;
        break;
      }
      case 0x06:
        S[sp] = S[sp - 2]; sp++; // OVER
        break;
      case 0x07: { // ROT ( a b c -- b c a )
        const a = S[sp - 3]; S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a;
        break;
      }
      case 0x17:
        S[sp - 1] = (-S[sp - 1]) | 0; // NEG, wraps
        break;
      case 0x1b:
        S[sp - 1] = ~S[sp - 1]; // NOT
        break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = S[sp - 1];
        const a = S[sp - 2];
        let r: number;
        switch (op) {
          case 0x10: r = (a + b) | 0; break;
          case 0x11: r = (a - b) | 0; break;
          case 0x12: r = Math.imul(a, b); break; // exact low 32 bits
          case 0x13: // DIV, signed, truncated toward zero
            if (b === 0) return R(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14: // MOD, sign of a
            if (b === 0) return R(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15: // DIVU, unsigned
            if (b === 0) return R(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16: // MODU, unsigned
            if (b === 0) return R(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18: r = a & b; break;
          case 0x19: r = a | b; break;
          case 0x1a: r = a ^ b; break;
          case 0x1c: r = a << (b & 31); break; // shift count: low 5 bits
          case 0x1d: r = a >> (b & 31); break;
          case 0x1e: r = (a >>> (b & 31)) | 0; break;
          case 0x20: r = a === b ? 1 : 0; break;
          case 0x21: r = a < b ? 1 : 0; break;
          default: r = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // LTU
        }
        sp -= 2;
        S[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: { // JMP / JZ / JNZ
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = S[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: // CALL, unsigned 16-bit target
        if (cp === 64) return R(7);
        C[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return R(8);
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const a = S[sp - 1];
        if (a < 0 || a >= 256) return R(6);
        S[sp - 1] = M[a];
        break;
      }
      case 0x41: { // STORE ( v addr -- )
        const a = S[sp - 1];
        const v = S[sp - 2];
        if (a < 0 || a >= 256) return R(6);
        sp -= 2;
        M[a] = v;
        break;
      }
      case 0x50: { // PRINT: decimal ASCII, no newline; a trap writes nothing
        const s = String(S[sp - 1]);
        if (ol + s.length > 65536) return R(11);
        sp--;
        for (let i = 0; i < s.length; i++) o[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC: one byte, v AND 255
        if (ol + 1 > 65536) return R(11);
        o[ol++] = S[--sp] & 255;
        break;
      case 0x52: // IN: next input byte, -1 once used up
        S[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53: // EXIT: low byte of v
        return R(S[--sp] & 255);
      default:
        return R(5); // unreachable: unknown opcodes trap above
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const program = readFileSync(join(I, id, 'program.bin'));
  let input: Buffer;
  try {
    input = readFileSync(join(I, id, 'input.bin'));
  } catch {
    input = Buffer.alloc(0);
  }
  const r = run(program, input);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out.subarray(0, r.len));
  writeFileSync(join(O, id, 'exit.txt'), `${r.exit}\n`);
}
