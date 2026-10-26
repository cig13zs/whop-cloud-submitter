#!/usr/bin/env node
// Laptop side, daily (\Creator\Whop Cloud Refresh). Renews the Content Rewards app session in agent Chrome and pushes
// it, plus the YouTube refresh tokens of every channel in queue.json, to this repo's Actions secrets. Values go to
// `gh secret set` over stdin and are never printed, logged or written to disk.
//
//   with_locks.ps1 -Owner refresh-session -Locks cr -NodeArgs refresh-session.mjs   # Whop session + YouTube
//   node refresh-session.mjs --yt                                                   # YouTube only, no browser
//   ... refresh-session.mjs --check   # whop_watch.py fallback: renew + check the session, print {"whop":"ok"}, set nothing
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const slash = p => p.replace(/\\/g, '/');
const AC = slash(process.env.WHOP_AC_DIR || path.join(homedir(), 'Desktop', 'CLAUDE CODE OUTPUTS', 'tools', 'agent-chrome'));
const KEYS = slash(process.env.WHOP_KEYS_DIR || path.join(homedir(), '.claude', 'keys'));
const APP = process.env.WHOP_APP_URL || 'https://b4e0vdqv6zgqeqj4pfgm.apps.whop.com/c/exp_zeADOv9rOOKk2x/campaigns';

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
  const channels = [...new Set(Object.values(JSON.parse(readFileSync(path.join(DIR, 'queue.json'), 'utf8'))).map(q => q.channel).filter(Boolean))];
  const tokens = {};
  for (const ch of channels) {
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
