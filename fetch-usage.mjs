#!/usr/bin/env node
// fetch-usage.mjs
// Fetches Claude API usage stats and writes to cache file.
// Usage: node fetch-usage.mjs [--force]
//   --force: skip cache age check (used by Stop hook)
//   default: skip if cache is < 60s old (used by PreToolUse hook)

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  existsSync,
} from "fs";
import { execSync } from "child_process";
import { tmpdir, homedir, platform } from "os";
import { join } from "path";
import { lockSync } from "proper-lockfile";

const CACHE_FILE = join(tmpdir(), ".claude_usage_cache.json");
const LOG_FILE = join(tmpdir(), ".claude_usage.log");
const LOG_MAX_BYTES = 50 * 1024; // 50 KB
const CACHE_MAX_AGE = 60; // seconds
const force = process.argv.includes("--force");

function log(msg, extra = {}) {
  const entry = { t: new Date().toISOString(), pid: process.pid, m: msg, ...extra };
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

function trimLogIfNeeded() {
  try {
    const st = statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    const content = readFileSync(LOG_FILE, "utf-8");
    const half = content.slice(content.length >>> 1);
    const firstNewline = half.indexOf("\n");
    writeFileSync(LOG_FILE, firstNewline >= 0 ? half.slice(firstNewline + 1) : half);
  } catch {}
}

function touchCache() {
  try {
    const existing = existsSync(CACHE_FILE)
      ? readFileSync(CACHE_FILE, "utf-8")
      : "{}";
    writeFileSync(CACHE_FILE, existing);
  } catch {}
}

// --- cache check ---
if (!force && existsSync(CACHE_FILE)) {
  try {
    const age = (Date.now() - statSync(CACHE_FILE).mtimeMs) / 1000;
    if (age < CACHE_MAX_AGE) process.exit(0);
  } catch {}
}

// --- acquire lock ---
// Ensure cache file exists before locking
if (!existsSync(CACHE_FILE)) writeFileSync(CACHE_FILE, "{}");

let release;
try {
  release = lockSync(CACHE_FILE, {
    realpath: false,
    onCompromised: () => process.exit(0),
  });
} catch {
  // Another process holds the lock — exit silently
  process.exit(0);
}

try {
  const age = (Date.now() - statSync(CACHE_FILE).mtimeMs) / 1000;
  log("fetch", { age: Math.round(age), ...(force ? { force: true } : {}) });
  trimLogIfNeeded();

  // --- get token ---
  const token = getToken();
  if (!token) {
    log("no_token");
    touchCache();
    process.exit(0);
  }

  // --- fetch usage ---
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "claude-code/statusline",
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    log("api_error", { status: res.status });
    touchCache();
    process.exit(0);
  }

  const data = await res.json();
  const cache = {
    five_hour: data.five_hour ?? null,
    seven_day: data.seven_day ?? null,
    fetched_at: Date.now(),
  };

  writeFileSync(CACHE_FILE, JSON.stringify(cache));

  const fivePct = data.five_hour
    ? Math.round((data.five_hour.used / data.five_hour.limit) * 100)
    : null;
  const sevenPct = data.seven_day
    ? Math.round((data.seven_day.used / data.seven_day.limit) * 100)
    : null;
  log("api_success", { five_hour_pct: fivePct, seven_day_pct: sevenPct });
} catch (err) {
  log("api_exception", { error: String(err?.message ?? err) });
  touchCache();
} finally {
  release();
}

// --- get token ---
function getToken() {
  // try credentials.json first (cross-platform)
  const credFile = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credFile)) {
    try {
      const creds = JSON.parse(readFileSync(credFile, "utf-8"));
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) return token;
    } catch {}
  }

  // macOS: try keychain
  if (platform() === "darwin") {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      if (raw) {
        // try plain JSON first
        try {
          const obj = JSON.parse(raw);
          if (obj?.claudeAiOauth?.accessToken)
            return obj.claudeAiOauth.accessToken;
        } catch {}
        // try hex-encoded JSON
        try {
          const decoded = Buffer.from(raw, "hex").toString("utf-8");
          const obj2 = JSON.parse(decoded);
          if (obj2?.claudeAiOauth?.accessToken)
            return obj2.claudeAiOauth.accessToken;
        } catch {}
        // fallback: regex match
        const match = raw.match(/sk-ant-oat01-[A-Za-z0-9_-]+/);
        if (match) return match[0];
      }
    } catch {}
  }

  return null;
}
