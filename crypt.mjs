#!/usr/bin/env node
// The repo is public (free, unlimited Actions minutes; private ran out on 2026-10-20), so the data files are committed
// only as AES-256-GCM `<file>.enc`. Plaintext stays local and gitignored. GCM also rejects any edited ciphertext.
// Key: DATA_KEY (Actions secret) or ~/.claude/keys/whop-runner-data.key on the laptop (base64, 32 bytes). Never printed.
//
//   node crypt.mjs open            # every *.json.enc -> *.json
//   node crypt.mjs seal [files]    # *.json -> *.json.enc, only when the content changed (fresh IVs would churn commits)
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DATA = ['queue.json', 'state.json', 'laptop-state.json'];
const KEY_FILE = 'C:/Users/Lorence/.claude/keys/whop-runner-data.key';
let k;
const key = () => k ??= Buffer.from(process.env.DATA_KEY || readFileSync(KEY_FILE, 'utf8').trim(), 'base64');

export function seal(text) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64') + '\n';
}

export function open(b64) {
  const b = Buffer.from(b64.trim(), 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

function main([cmd, ...files]) {
  const at = f => path.join(DIR, f);
  if (cmd === 'open') {
    for (const f of DATA) if (existsSync(at(f + '.enc'))) writeFileSync(at(f), open(readFileSync(at(f + '.enc'), 'utf8')));
  } else if (cmd === 'seal') {
    for (const f of files.length ? files : DATA) {
      if (!existsSync(at(f))) continue;
      const text = readFileSync(at(f), 'utf8');
      if (existsSync(at(f + '.enc')) && open(readFileSync(at(f + '.enc'), 'utf8')) === text) continue;
      writeFileSync(at(f + '.enc'), seal(text));
    }
  } else if (cmd === 'selftest') {
    k = randomBytes(32);
    const s = seal('{"a":1}');
    if (open(s) !== '{"a":1}' || seal('x') === seal('x')) throw new Error('round trip');
    const bad = Buffer.from(s.trim(), 'base64'); bad[30] ^= 1;
    let threw = false; try { open(bad.toString('base64')); } catch { threw = true; }
    if (!threw) throw new Error('tampered ciphertext was accepted');
    console.log('crypt selftest ok');
  } else throw new Error('usage: node crypt.mjs open | seal [files] | selftest');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
