#!/usr/bin/env node
// fetch-usage.mjs
// Fetches Claude API usage stats and writes to cache file.
// Usage: node fetch-usage.mjs [--force]
//   --force: skip cache age check (used by Stop hook)
//   default: skip if cache is < 60s old (used by PreToolUse hook)

import { readFileSync, writeFileSync, statSync, existsSync } from "fs";
import { execSync } from "child_process";
import { tmpdir, homedir, platform } from "os";
import { join } from "path";

const CACHE_FILE = join(tmpdir(), ".claude_usage_cache.json");
const CACHE_MAX_AGE = 60; // seconds
const force = process.argv.includes("--force");

// --- cache check ---
if (!force && existsSync(CACHE_FILE)) {
  try {
    const age = (Date.now() - statSync(CACHE_FILE).mtimeMs) / 1000;
    if (age < CACHE_MAX_AGE) process.exit(0);
  } catch {}
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

const token = getToken();
if (!token) process.exit(0);

// --- fetch usage ---
try {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "claude-code/2.1.11",
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) process.exit(0);

  const data = await res.json();
  const cache = {
    five_hour: data.five_hour ?? null,
    seven_day: data.seven_day ?? null,
    fetched_at: Date.now(),
  };

  writeFileSync(CACHE_FILE, JSON.stringify(cache));
} catch {
  process.exit(0);
}
