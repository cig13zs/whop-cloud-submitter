#!/usr/bin/env node
// Quota-independent 30-min watchdog. Reads queue.json + state.json (cloud submitter format), checks public via oEmbed
// (YouTube/TikTok, no API quota), writes SUBMIT-NOW.json (public, unsubmitted, <=28 min) and REPOST-QUEUE.json (>28 min).
// Exit 2 only for a new miss still inside the submit window (public 25–28 min). Clips already in
// REPOST-QUEUE (public >28 min) are logged and do not fail the run. Quota never alerts.
// Monitor and Instagram API entries are not submit candidates, so a public one is not a missed Content Rewards post.
//   node guard/watchdog.mjs queue.json state.json [outdir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const UA = 'Mozilla/5.0';
const slot = at => Date.parse(String(at).replace(' ', 'T') + ':00+08:00');

export async function scan(queue, state, now, isPublic) {
  const submitNow = [], repost = [], misses = [];
  for (const [vid, q] of Object.entries(queue)) {
    const s = state[vid] || {};
    if (s.submitted || s.submission_terminal || !q.at) continue;
    if (q.mode === 'monitor' || q.mode === 'api' || q.platform === 'instagram') continue;
    const since = s.published ? Date.parse(s.published) : slot(q.at);
    const age = (now - since) / 60e3;
    if (!Number.isFinite(age) || age < -2 || age > 180) continue;
    if (!(await isPublic(vid, q))) continue;
    const row = { vid, campaign: q.campaign, platform: q.platform || 'youtube', url: q.url || `https://www.youtube.com/shorts/${vid}`, age_min: Math.round(age), since: new Date(since).toISOString() };
    (age > 28 ? repost : submitNow).push(row);
    if (age > 25) misses.push(row);
  }
  return { submitNow, repost, misses };
}

// Repost-queue rows are already-known burned ids. They must not exit 2 every 5 minutes.
// A miss still in SUBMIT-NOW (25–28 min) still alerts. skipBefore is an extra cutoff for anything older.
export function missesToAlert(misses, repost = [], skipBefore = '') {
  const burned = new Set(repost.map(r => r.vid));
  const cut = Date.parse(skipBefore || '');
  return misses.filter(m => {
    if (burned.has(m.vid)) return false;
    if (Number.isFinite(cut) && Date.parse(m.since) < cut) return false;
    return true;
  });
}

async function oembedPublic(vid, q) {
  if (q.platform === 'tiktok') return fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(q.url)}`, { headers: { 'user-agent': UA } }).then(r => r.ok, () => null);
  for (const page of [`https://www.youtube.com/watch?v=${vid}`, `https://www.youtube.com/shorts/${vid}`]) {
    try {
      if ((await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(page)}`, { headers: { 'user-agent': UA } })).ok) return true;
    } catch { /* try the other URL */ }
  }
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [qf, sf, out = '.'] = process.argv.slice(2);
  const queue = JSON.parse(readFileSync(qf, 'utf8')), state = JSON.parse(readFileSync(sf, 'utf8'));
  const { submitNow, repost, misses } = await scan(queue, state, Date.now(), oembedPublic);
  const alerting = missesToAlert(misses, repost, process.env.SKIP_OLD_MISSES_BEFORE || '');
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/SUBMIT-NOW.json`, JSON.stringify(submitNow, null, 1));
  writeFileSync(`${out}/REPOST-QUEUE.json`, JSON.stringify(repost, null, 1));
  if (repost.length) console.log(`repost-queue ${repost.length} already-known; not failing`);
  console.log(`submit-now ${submitNow.length}, repost ${repost.length}, real misses ${alerting.length}`);
  if (alerting.length) { console.error('REAL MISS: ' + alerting.map(m => `${m.vid} ${m.age_min}m`).join(' | ')); process.exitCode = 2; }
}
