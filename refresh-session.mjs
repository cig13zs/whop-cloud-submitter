#!/usr/bin/env node
// Laptop side, daily (\Creator\Whop Cloud Refresh). Renews the Content Rewards app session in agent Chrome and pushes
// it, plus the YouTube refresh tokens of every channel in queue.json, to this repo's Actions secrets. Values go to
// `gh secret set` over stdin and are never printed, logged or written to disk.
//
//   with_locks.ps1 -Owner refresh-session -Locks cr -NodeArgs refresh-session.mjs   # Whop session + YouTube
//   node refresh-session.mjs --yt                                                   # YouTube only, no browser
//   ... refresh-session.mjs --check   # whop_watch.py fallback: renew + check the session, print {"whop":"ok"}, set nothing
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const slash = p => p.replace(/\\/g, '/');
const AC = slash(process.env.WHOP_AC_DIR || path.join(homedir(), 'Desktop', 'CLAUDE CODE OUTPUTS', 'tools', 'agent-chrome'));
const KEYS = slash(process.env.WHOP_KEYS_DIR || path.join(homedir(), '.claude', 'keys'));
const YTQ_CONFIG = path.resolve(DIR, '..', '..', '..', 'tools', 'ytq', 'config.json');
const APP = process.env.WHOP_APP_URL || 'https://b4e0vdqv6zgqeqj4pfgm.apps.whop.com/c/exp_zeADOv9rOOKk2x/campaigns';

// P0 Anti-Ban Firewall (2026-11-28): never export refresh tokens for terminated/quarantined channels or accounts.
const TERMINATED_ACCOUNTS = new Set(['lrnsdc', 'whopclippingxx1', 'whopclipping3xx']);
const TERMINATED_CHANNELS = new Set([
  'UCSNtJALmEpivjopI-KD3zgA', 'UCMA3hbf03deFQciSPqhS47w', 'UCMfeRlsfComsw9t7lqidaIg',
  'UCYyu_RrDxU4uf3Dt89p51-A', 'UCK-8kboJ5Cgc7t8HK_2ra-A', 'UCgyvh-CTVC3O5TQ7r1IldPw',
  'UCKKpxv3IzEtGinueX3QRVOw', 'UCPwiaBsnEP-HRN0cjjYyZ0Q', 'UCD_2imVu4qfifvQ33i7K75A',
  'UCGIPbWozVMPNzHkfIiC0ZZw', 'UCSrjOnGWmTjFchhEIfHCC1w', 'UCygfYzxU0GFOvMQ82rO9Vhg',
  'UCmxGazu1_EuIqfRuuN31FTw', 'UCgojoQRXenWhNvgUOJgl1ig', 'UCfbSGGOu710aN1jR4FCALMA',
  'UCDqMk5Ea58hGt7Kd97OrzFw', 'UCCwVMi_ld5BtxwICqVs8wVA', 'UC2LBGopKzm8s3lLj1CQdS5w',
  'UC0PrT71Wsjdx3KKgjMXl9vw', 'UCy1nKwYzPZmPZKlMCJD29oQ', 'UC6gRxcVY1LOHWaqutG27vDQ',
  'UCpIRQIt0m1GlArCesaLCypg', 'UC_1AYskXlX0E3sOO0Z23J2Q',
]);

function loadTerminatedCheck() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(YTQ_CONFIG, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  const accts = new Set([...TERMINATED_ACCOUNTS, ...(cfg.terminated_accounts || [])]);
  const chs = new Set([...TERMINATED_CHANNELS, ...Object.keys(cfg.terminated_channels || {})]);
  return ch => {
    if (!ch || chs.has(ch)) return true;
    const info = cfg.channels?.[ch];
    if (info?.terminated === true || (info?.account && accts.has(info.account))) return true;
    const rest = cfg.resting_channels?.[ch];
    return typeof rest === 'string' && rest.startsWith('2099-');
  };
}

// --local: run run.mjs on this laptop with the same values in its env instead of pushing them to Actions secrets.
// whop_watch.py does this while the laptop is on, so it costs no Actions minutes (dispatching ~100 cloud runs a day
// used up October's 2,000 free minutes by the 20th).
const LOCAL = process.argv.includes('--local');

function setSecret(name, value) {
  if (!value) throw new Error(`refusing to set an empty ${name}`);
  if (LOCAL) return void (process.env[name] = value);
  const r = spawnSync('gh', ['secret', 'set', name], { cwd: DIR, input: value, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`gh secret set ${name} failed: ${(r.stderr || '').trim().slice(0, 300)}`);
  console.log(`${name} updated`);
}

async function whop() {
  const { ENDPOINT, ensureChrome } = await import('file:///' + AC + '/chrome.mjs');
  const { chromium } = createRequire(path.join(process.env.APPDATA, 'npm', 'node_modules', '@playwright', 'mcp', 'package.json'))('playwright-core');
  await ensureChrome();
  const browser = await chromium.connectOverCDP(ENDPOINT, { timeout: 90000 });
  try {
    // Each launch mints a fresh 30-day __Host-cr-session; older sessions keep working (checked 2026-09-30).
    const page = await browser.contexts()[0].newPage();
    // 'load' timed out at 30 s on a busy agent Chrome (2026-10-20); the waitForURL below is the real check.
    await page.goto(`https://whop.com/core/app/launch/?redirect=${encodeURIComponent(APP)}`, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForURL(u => u.href.startsWith(APP), { timeout: 60000 });
    await page.close();
    const { cookies } = await (await browser.newBrowserCDPSession()).send('Storage.getCookies');
    const pick = n => cookies.find(c => c.name === n && c.domain.endsWith('apps.whop.com'));
    const session = pick('__Host-cr-session'), id = pick('__Host-cr-whop-id');
    if (!session || !id) throw new Error('agent Chrome has no Content Rewards session: sign in to Whop there once');
    process.env.WHOP_CR_COOKIE = `__Host-cr-session=${session.value}; __Host-cr-whop-id=${id.value}`;
  } finally {
    await browser.close().catch(() => {});
  }
  const { whopCheck } = await import('./run.mjs');
  const check = await whopCheck(); // prove the pair works over plain fetch before replacing the secret
  if (process.argv.includes('--check')) return console.log(JSON.stringify({ whop: check }));
  if (check !== 'ok') throw new Error(`new Whop session failed its check: ${check}`);
  setSecret('WHOP_CR_COOKIE', process.env.WHOP_CR_COOKIE);
}

function youtube() {
  const { client_id, client_secret } = JSON.parse(readFileSync(`${KEYS}/youtube-oauth-client.json`, 'utf8')).installed;
  setSecret('YT_CLIENT', JSON.stringify({ client_id, client_secret }));
  // queue channels (submitter) + uploads.json channels (cloud uploader, upload.mjs)
  const uploads = existsSync(path.join(DIR, 'uploads.json')) ? JSON.parse(readFileSync(path.join(DIR, 'uploads.json'), 'utf8')) : [];
  const channels = [...new Set([...Object.values(JSON.parse(readFileSync(path.join(DIR, 'queue.json'), 'utf8'))), ...uploads].map(q => q.channel).filter(Boolean))];
  const isTerminated = loadTerminatedCheck();
  const tokens = {};
  for (const ch of channels) {
    if (isTerminated(ch)) {
      console.log(`${ch}: skipped (terminated/quarantined by Anti-Ban Firewall)`);
      continue;
    }
    // 11-23: one old queue channel never consented (no token file) blocked every channel's refresh. A queue channel
    // without a token only loses the private-status read; an uploads.json channel can't upload without one, so it fails.
    if (!existsSync(`${KEYS}/yt-tokens/${ch}.json`)) {
      if (uploads.some(u => u.channel === ch)) throw new Error(`${ch}: no YouTube token, and the cloud uploader needs one (node tools/ytapi/auth.mjs ${ch})`);
      console.log(`${ch}: no token file; skipped (queue channel only)`);
      continue;
    }
    const t = JSON.parse(readFileSync(`${KEYS}/yt-tokens/${ch}.json`, 'utf8'));
    const consented = t.consented_at ?? t.obtained_at, age = (Date.now() - consented) / 86_400_000;
    // The OAuth app is In production since 2026-10-07: only tokens consented before that (Testing) lapse after 7 days.
    const testing = consented < Date.parse('2026-10-07T00:00:00+08:00');
    console.log(`${ch}: token consented ${age.toFixed(1)} days ago${testing && age > 6 ? ' - OVER 6 DAYS, re-consent soon (node tools/ytapi/auth.mjs)' : ''}`);
    tokens[ch] = t.refresh_token;
  }
  setSecret('YT_REFRESH_TOKENS', JSON.stringify(tokens)); // ponytail: queue channels only, so a leak exposes fewer channels
}

try {
  if (!process.argv.includes('--yt')) await whop();
  if (!process.argv.includes('--check')) youtube();
  if (LOCAL) process.env.STATE_OUT = 'laptop-state.json';
  if (LOCAL) process.exitCode = spawnSync(process.execPath, ['run.mjs', ...process.argv.filter(a => a === '--dry-run')], { cwd: DIR, stdio: 'inherit', env: process.env, windowsHide: true }).status ?? 1;
} catch (e) {
  console.error(`refresh-session failed: ${e.message}`);
  if (process.argv.includes('--check')) console.log(JSON.stringify({ whop: e.message.slice(0, 200) }));
  process.exitCode = 1;
}
