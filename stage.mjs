#!/usr/bin/env node
// Laptop side of the cloud uploader (upload.mjs). Moves queued ytq clips to the cloud so they upload with
// the laptop off. Run it any time after a clip is approved; days ahead is fine.
//
//   node stage.mjs <slug> [slug...]   encrypt each mp4 into the draft release yt-media, add it to uploads.json,
//                                     take it off the laptop queue (ytq state needs_human "cloud: staged")
//   node stage.mjs sync               copy cloud results (video ids) back into the ytq job files
//   node stage.mjs list               show uploads.json
//
// Refuses to stage while the repo variable UPLOAD_ON is not "true" (the API audit is not through yet),
// because a staged clip leaves the laptop queue.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealBytes } from './crypt.mjs';
import { assetName } from './upload.mjs';
import { loadJobs, allItems, updateItem } from '../../../tools/ytq/lib.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'uploads.json');
const REPO = 'cig13zs/whop-cloud-submitter';
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: DIR, stdio: 'pipe', timeout: 600_000, windowsHide: true }).toString().trim();
const node = args => sh(process.execPath, args);
const rows = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []);

// ytq keeps Manila wall-clock date + time ("Nov 15, 2026", "10:00 PM").
export const publishAtIso = (date, time) => {
  const ms = Date.parse(`${date} ${time} GMT+0800`);
  if (!Number.isFinite(ms)) throw new Error(`bad slot ${date} ${time}`);
  return new Date(ms).toISOString();
};

function pullAndOpen() { sh('git', ['pull', '-q', '--rebase']); node(['crypt.mjs', 'open']); }
function sealAndPush(msg) {
  node(['crypt.mjs', 'seal', 'uploads.json']);
  sh('git', ['add', '--', 'uploads.json.enc']);
  try { sh('git', ['diff', '--cached', '--quiet']); return; } catch { /* staged changes: commit them */ }
  sh('git', ['commit', '-q', '-m', msg]);
  for (let i = 0; i < 3; i++) { try { sh('git', ['pull', '-q', '--rebase']); sh('git', ['push', '-q']); return; } catch (e) { if (i === 2) throw e; } }
}

function stage(slugs, force) {
  if (!force && sh('gh', ['variable', 'get', 'UPLOAD_ON', '-R', REPO]).toLowerCase() !== 'true') {
    throw new Error('UPLOAD_ON is not true (API audit not through?): staging would strand clips. Use --force only for a test.');
  }
  pullAndOpen();
  const list = rows();
  const items = allItems(loadJobs());
  try { sh('gh', ['release', 'view', 'yt-media', '-R', REPO]); }
  catch { sh('gh', ['release', 'create', 'yt-media', '--draft', '--title', 'yt-media', '--notes', 'Encrypted clip files for upload.mjs. Draft: never public.', '-R', REPO]); }
  const newChannels = new Set();
  for (const slug of slugs) {
    const it = items.find(x => x.slug === slug);
    if (!it) throw new Error(`${slug}: not in any ytq job file`);
    if (it.state !== 'queued') throw new Error(`${slug}: ytq state is ${it.state}, only queued clips can move to the cloud`);
    if (list.some(r => r.slug === slug && !['failed', 'missed'].includes(r.state))) throw new Error(`${slug}: already in uploads.json`);
    if (!list.some(r => r.channel === it.channel_id)) newChannels.add(it.channel_id);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'stage-'));
    try {
      const enc = path.join(tmp, assetName(slug));
      writeFileSync(enc, sealBytes(readFileSync(it.file)));
      sh('gh', ['release', 'upload', 'yt-media', enc, '--clobber', '-R', REPO]);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    list.push({ slug, channel: it.channel_id, title: it.title, description: it.description || '', publishAt: publishAtIso(it.date, it.time),
      campaign: it.campaign || null, state: 'staged', staged_at: new Date().toISOString() });
    writeFileSync(FILE, JSON.stringify(list, null, 1) + '\n');
    updateItem(it.jobFile, slug, x => { x.state = 'needs_human'; x.last_error = 'cloud: staged (cloud-submitter uploads.json)'; return 'staged to cloud uploader'; });
    console.log(`${slug}: staged for ${it.channel_name || it.channel_id} at ${it.date} ${it.time} Manila`);
  }
  sealAndPush(`uploads: stage ${slugs.length}`);
  // The cloud needs a refresh token for each channel it uploads to.
  if (newChannels.size) { console.log(`new channel(s) ${[...newChannels].join(', ')}: refreshing YT_REFRESH_TOKENS`); console.log(node(['refresh-session.mjs', '--yt'])); }
}

function sync() {
  pullAndOpen();
  const items = allItems(loadJobs());
  for (const r of rows().filter(r => r.video_id)) {
    const it = items.find(x => x.slug === r.slug);
    if (!it || it.video_id === r.video_id) continue;
    updateItem(it.jobFile, r.slug, x => {
      Object.assign(x, { state: 'verified', video_id: r.video_id, url: `https://youtube.com/shorts/${r.video_id}`, last_error: null });
      return `cloud upload ${r.state}`;
    });
    console.log(`${r.slug}: ${r.video_id} (${r.state})`);
  }
  for (const r of rows().filter(r => ['failed', 'missed', 'locked'].includes(r.state))) console.log(`NEEDS A LOOK ${r.slug}: ${r.state} ${r.error || ''}`);
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'sync') sync();
  else if (cmd === 'list') { pullAndOpen(); for (const r of rows()) console.log(`${r.state.padEnd(8)} ${r.publishAt} ${r.slug} ${r.video_id || ''}`); }
  else if (cmd === 'selftest') {
    if (publishAtIso('Nov 15, 2026', '10:00 PM') !== '2026-11-15T14:00:00.000Z') throw new Error('Manila slot -> UTC');
    if (publishAtIso('Nov 16, 2026', '4:00 AM') !== '2026-11-15T20:00:00.000Z') throw new Error('early slot crosses the day back');
    console.log('stage selftest ok');
  }
  else if (cmd && !cmd.startsWith('-')) stage([cmd, ...rest].filter(s => !s.startsWith('-')), rest.includes('--force'));
  else throw new Error('usage: node stage.mjs <slug...> [--force] | sync | list | selftest');
} catch (e) { console.error(e.message); process.exitCode = 1; }
