#!/usr/bin/env node
// Merge a one-shot channel-map override into the decrypted channel-map.json.
// Prints id -> campaign id lines only. Never prints DATA_KEY, the key file, or the rest of the map.
//
//   node map-edit.mjs apply-file channel-map.override.json
//   node map-edit.mjs resolve-file channel-map.override.json before|after|readback
//   node map-edit.mjs register channel-map.override.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(DIR, 'channel-map.json');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const UC = /^UC[\w-]{22}$/;
const VID = /^[\w-]{11}$/;
const HANDLE = /^@[A-Za-z0-9._-]+$/;

const readJson = file => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`could not read ${path.basename(file)}`); }
};

export function lookup(data, spec) {
  const at = spec.indexOf('@');
  if (at > 0) {
    const vid = spec.slice(0, at), channel = spec.slice(at + 1);
    if (data.videos?.[vid]) return data.videos[vid];
    return data.channels?.[channel] ?? null;
  }
  if (data.videos?.[spec]) return data.videos[spec];
  if (data.channels?.[spec]) return data.channels[spec];
  return data.pending?.[spec] ?? null;
}

export function formatValue(value) {
  if (value == null) return 'UNMAPPED';
  if (typeof value === 'string') return value;
  const ids = [...new Set(Object.values(value).filter(v => typeof v === 'string'))];
  return `JOINT ${ids.join(',')}`;
}

// Adds channels, videos, and pending keys. Refuses to change an existing channel's campaign.
// A videos entry may be set or replaced: that is the per-video override.
export function mergeMap(data, patch) {
  const next = structuredClone(data);
  next.channels ??= {};
  let set = 0;
  for (const section of ['channels', 'videos', 'pending']) {
    const incoming = patch[section];
    if (!incoming) continue;
    if (incoming.constructor !== Object) throw new Error(`override ${section} is not an object`);
    next[section] ??= {};
    for (const [key, raw] of Object.entries(incoming)) {
      if (typeof raw !== 'string' || !UUID.test(raw)) throw new Error(`override ${section} has a non-uuid campaign`);
      if (section === 'channels' && !UC.test(key)) throw new Error('override channel key is not a UC id');
      if (section === 'videos' && !VID.test(key)) throw new Error('override video key is not an 11-character id');
      if (section === 'pending' && !HANDLE.test(key)) throw new Error('override pending key is not an @handle');
      const value = raw.toLowerCase();
      const current = data[section]?.[key];
      if (section === 'channels' && current != null) {
        if (typeof current === 'string' && current.toLowerCase() === value) continue;
        throw new Error(`refusing to remap channel ${key}`);
      }
      if (typeof current === 'string' && current.toLowerCase() === value) continue;
      next[section][key] = value;
      set++;
    }
  }
  if (patch.register) {
    if (!Array.isArray(patch.register)) throw new Error('override register is not a list');
    for (const entry of patch.register) {
      if (typeof entry !== 'string' || !/^[\w-]{11}=[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(entry)) throw new Error('override register entry is malformed');
    }
  }
  const before = Object.keys(data.channels || {}).length;
  if (Object.keys(next.channels).length < before) throw new Error('refusing to drop channels');
  return { data: next, set, before, after: Object.keys(next.channels).length };
}

function resolveFile(file, label) {
  const patch = readJson(file);
  const data = existsSync(MAP) ? readJson(MAP) : { channels: {} };
  const specs = patch.resolve || [];
  console.log(`RESOLVE ${label} channels=${Object.keys(data.channels || {}).length} videos=${Object.keys(data.videos || {}).length}`);
  for (const spec of specs) console.log(`RESOLVE ${label} ${spec} -> ${formatValue(lookup(data, spec))}`);
}

function applyFile(file) {
  const patch = readJson(file);
  const data = readJson(MAP);
  const { data: next, set, before, after } = mergeMap(data, patch);
  if (set) writeFileSync(MAP, JSON.stringify(next, null, 1) + '\n');
  console.log(`map-apply: set ${set} keys; channels ${before} -> ${after}`);
}

async function registerFile(file) {
  const patch = readJson(file);
  const list = patch.register || [];
  if (!list.length) { console.log('register: none'); return; }
  mergeMap(readJson(MAP), patch); // validate before any network call
  const { registerHints, parseHints, CHANNEL_MAP, VIDEO_MAP, mergeLaptop } = await import('./run.mjs');
  const map = readJson(MAP);
  Object.assign(CHANNEL_MAP, map.channels || {});
  Object.assign(VIDEO_MAP, map.videos || {});
  const queue = readJson(path.join(DIR, 'queue.json'));
  const state = readJson(path.join(DIR, 'state.json'));
  const laptop = path.join(DIR, 'laptop-state.json');
  if (existsSync(laptop)) mergeLaptop(state, readJson(laptop));
  const parsed = parseHints(list.join(','));
  const hints = parsed.filter(Array.isArray);
  const hide = s => String(s).replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi, '[campaign]');
  const io = {
    dry: false, fatal: [],
    log: m => console.log(hide(m)),
    save() { writeFileSync(path.join(DIR, 'state.json'), JSON.stringify(state, null, 1) + '\n'); },
  };
  const n = await registerHints(hints, queue, state, Date.now(), io);
  if (io.fatal.length) console.log(io.fatal.map(hide).join(' | '));
  console.log(`register: ${n} new, ${hints.length - n} already tracked or refused`);
  if (io.fatal.some(f => f.startsWith('REGISTER-REJECTED'))) process.exitCode = 1;
}

async function main() {
  const [cmd, file, label] = process.argv.slice(2);
  if (!file) throw new Error('usage: node map-edit.mjs apply-file|resolve-file|register <override.json> [label]');
  if (cmd === 'apply-file') applyFile(file);
  else if (cmd === 'resolve-file') resolveFile(file, label || 'readback');
  else if (cmd === 'register') await registerFile(file);
  else throw new Error('usage: node map-edit.mjs apply-file|resolve-file|register <override.json> [label]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
