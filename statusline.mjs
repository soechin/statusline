#!/usr/bin/env node
// statusline.mjs
// Reads Claude Code JSON from stdin + usage cache, outputs two-line statusline.
// Line 1: ❖ model | ⌂ folder · ⎇ branch
// Line 2: ▓▓░░░░░░░░ ctx% · 5h: N% (~Xh Ym) · 7d: N% (~Xd Yh)

import { readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { execSync } from "child_process";

const CACHE_FILE = join(tmpdir(), ".claude_usage_cache.json");
const RIGHT_NOTIFICATION_RESERVE = 20;

// --- read stdin ---
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());

// --- ANSI helpers ---
const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";
const gray = rgb(156, 162, 175);
const cyan = rgb(80, 200, 200);
const sep = `${rgb(90, 90, 90)} · ${reset}`;
const pipe = `${rgb(90, 90, 90)} | ${reset}`;

// --- text utilities ---
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(str) {
  return stripAnsi(str).length;
}

function truncateVisible(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function truncateAnsi(str, maxLen) {
  if (visibleLength(str) <= maxLen) return str;
  let visible = 0;
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\x1b" && str[i + 1] === "[") {
      let j = i + 2;
      while (j < str.length && str[j] !== "m") j++;
      result += str.slice(i, j + 1);
      i = j + 1;
    } else {
      if (visible >= maxLen - 3) break;
      result += str[i];
      visible++;
      i++;
    }
  }
  return result + "..." + reset;
}

// --- terminal width ---
function getTerminalWidth() {
  try {
    const out = execSync("stty size < /dev/tty", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 1000,
    }).trim();
    const [, cols] = out.split(" ");
    const width = parseInt(cols, 10);
    if (Number.isFinite(width) && width > 0) return width;
  } catch {}
  const envCols = parseInt(process.env.COLUMNS ?? "", 10);
  if (Number.isFinite(envCols) && envCols > 0) return envCols;
  return null;
}

// --- colors by threshold ---
function usageColor(pct) {
  if (pct >= 90) return rgb(239, 68, 68);   // red
  if (pct >= 80) return rgb(249, 115, 22);  // orange
  if (pct >= 70) return rgb(234, 179, 8);   // yellow
  return gray;
}

// rate-aware color: stays gray if usage% < elapsed%
function smartColor(pct, resetsAt, windowHours) {
  if (resetsAt) {
    const resetMs = new Date(resetsAt).getTime();
    const now = Date.now();
    const windowMs = windowHours * 3600 * 1000;
    const elapsed = 1 - (resetMs - now) / windowMs;
    const elapsedPct = Math.max(0, Math.min(1, elapsed)) * 100;
    if (pct <= elapsedPct) return gray;
    if (pct < 70) return cyan;  // over pace but not yet critical
  }
  return usageColor(pct);
}

// --- progress bar (FlineDev style) ---
function progressBar(pct, width = 10, color) {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `${color}${"▓".repeat(filled)}${"░".repeat(empty)}${reset}`;
}

// --- time delta ---
function timeDelta(isoStr) {
  if (!isoStr) return null;
  const diff = new Date(isoStr).getTime() - Date.now();
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (d > 0) return `~${d}d ${h}h`;
  if (h > 0) return `~${h}h ${m}m`;
  return `~${m}m`;
}

// --- model ---
const model = input?.model?.display_name ?? "";

// --- folder ---
const dir = input?.workspace?.current_dir ?? input?.cwd ?? "";
const dirName = basename(dir);

// --- git branch ---
let branch = "";
if (dir) {
  try {
    branch = execSync("git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
  } catch {}
}

// --- git file changes ---
let gitChanges = "";
if (dir && branch) {
  try {
    const status = execSync("git status --porcelain 2>/dev/null", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    if (status) {
      let added = 0, modified = 0, deleted = 0;
      for (const line of status.split("\n")) {
        const code = line.slice(0, 2);
        if (code.includes("D")) deleted++;
        else if (code.includes("M")) modified++;
        else if (code.includes("?") || code.includes("A")) added++;
      }
      const parts = [];
      if (added) parts.push(`+${added}`);
      if (modified) parts.push(`~${modified}`);
      if (deleted) parts.push(`-${deleted}`);
      gitChanges = parts.join(" ");
    }
  } catch {}
}

// --- context window ---
const ctxPct = input?.context_window?.used_percentage;
let ctxData;
if (ctxPct != null) {
  const pct = Math.round(ctxPct);
  const color = usageColor(pct);
  let tokensStr = "";
  const cu = input?.context_window?.current_usage;
  const total = input?.context_window?.context_window_size;
  if (cu && total) {
    const used =
      (cu.cache_read_input_tokens ?? 0) +
      (cu.cache_creation_input_tokens ?? 0) +
      (cu.input_tokens ?? 0) +
      (cu.output_tokens ?? 0);
    tokensStr = `(${Math.round(used / 1000)}k/${Math.round(total / 1000)}k)`;
  }
  ctxData = { pct, color, tokensStr };
} else {
  ctxData = { pct: 0, color: gray, tokensStr: "" };
}

// --- usage from cache ---
let fiveData = null;
let sevenData = null;
let usageStale = false;
if (existsSync(CACHE_FILE)) {
  try {
    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));

    if (cache.fetched_at) {
      const staleThr = (cache.cooldown ?? 300) * 1000 * 2;
      usageStale = (Date.now() - cache.fetched_at) >= staleThr;
    }

    if (cache.five_hour?.utilization != null) {
      const pct = Math.round(cache.five_hour.utilization);
      const color = smartColor(pct, cache.five_hour.resets_at, 5);
      const delta = timeDelta(cache.five_hour.resets_at);
      fiveData = { pct, color, delta };
    }

    if (cache.seven_day?.utilization != null) {
      const pct = Math.round(cache.seven_day.utilization);
      const color = smartColor(pct, cache.seven_day.resets_at, 168);
      const delta = timeDelta(cache.seven_day.resets_at);
      sevenData = { pct, color, delta };
    }
  } catch {}
}

// --- build line 1 with adaptive truncation ---
function buildLine1(model, dirName, branch, gitChanges, maxWidth) {
  const modelColor = rgb(110, 170, 255);
  const dirColor = gray;
  const branchColor = gray;
  const changesColor = rgb(180, 180, 180);

  const build = (m, d, b, g) => {
    let line = `${modelColor}${m}${reset}`;
    if (d) {
      line += `${pipe}${dirColor}${d}${reset}`;
      if (b) {
        line += `${pipe}${branchColor}${b}${reset}`;
        if (g) line += ` ${changesColor}${g}${reset}`;
      }
    }
    return line;
  };

  if (!maxWidth) return build(model, dirName, branch, gitChanges);

  // 1. 完整顯示（含 gitChanges）
  let line = build(model, dirName, branch, gitChanges);
  if (visibleLength(line) <= maxWidth) return line;

  // 2. 隱藏 gitChanges
  line = build(model, dirName, branch, "");
  if (visibleLength(line) <= maxWidth) return line;

  // 3. 截斷 branch name
  if (branch) {
    const baseLen = visibleLength(build(model, dirName, "", ""));
    const availForBranch = maxWidth - baseLen - 2; // 2 for spaces before branch
    if (availForBranch >= 3) {
      line = build(model, dirName, truncateVisible(branch, availForBranch), "");
      if (visibleLength(line) <= maxWidth) return line;
    }
  }

  // 4. 隱藏 branch
  line = build(model, dirName, "", "");
  if (visibleLength(line) <= maxWidth) return line;

  // 5. 截斷 folder name
  if (dirName) {
    const availForDir = maxWidth - model.length - 3; // 3 for pipe " | "
    if (availForDir >= 3) {
      line = build(model, truncateVisible(dirName, availForDir), "", "");
      if (visibleLength(line) <= maxWidth) return line;
    }
  }

  // 6. 隱藏 folder + branch
  line = build(model, "", "", "");
  if (visibleLength(line) <= maxWidth) return line;

  // 7. 截斷 model name
  return `${modelColor}${bold}${truncateVisible(model, maxWidth)}${reset}`;
}

// --- build line 2 with adaptive truncation ---
function buildLine2(ctxData, fiveData, sevenData, usageStale, maxWidth) {
  const buildCtx = (showTokens, barWidth = 10) => {
    const bar = progressBar(ctxData.pct, barWidth, ctxData.color);
    let s = `${bar} ${ctxData.color}${ctxData.pct}%${reset}`;
    if (showTokens && ctxData.tokensStr) {
      s += ` ${dim}${gray}${ctxData.tokensStr}${reset}`;
    }
    return s;
  };

  const buildFive = (showDelta, barWidth = 5) => {
    if (!fiveData) return "";
    let s = "";
    if (barWidth > 0) {
      const barColor = usageStale ? `${dim}${fiveData.color}` : fiveData.color;
      const bar = progressBar(fiveData.pct, barWidth, barColor);
      s += `${bar} `;
    }
    if (usageStale) {
      s += `${dim}${fiveData.color}?${reset}`;
    } else {
      s += `${fiveData.color}${fiveData.pct}%${reset}`;
    }
    if (showDelta && fiveData.delta) s += ` ${dim}${gray}(${fiveData.delta})${reset}`;
    return s;
  };

  const buildSeven = (showDelta, barWidth = 5) => {
    if (!sevenData) return "";
    let s = "";
    if (barWidth > 0) {
      const barColor = usageStale ? `${dim}${sevenData.color}` : sevenData.color;
      const bar = progressBar(sevenData.pct, barWidth, barColor);
      s += `${bar} `;
    }
    if (usageStale) {
      s += `${dim}${sevenData.color}?${reset}`;
    } else {
      s += `${sevenData.color}${sevenData.pct}%${reset}`;
    }
    if (showDelta && sevenData.delta) s += ` ${dim}${gray}(${sevenData.delta})${reset}`;
    return s;
  };

  const joinParts = (parts) => parts.filter(Boolean).join(pipe);

  const tryBuild = (showTokens, showFiveDelta, showSevenDelta, showSeven, showFive, ctxBarWidth = 10, fiveBarWidth = 5, sevenBarWidth = 5) => {
    return joinParts([
      buildCtx(showTokens, ctxBarWidth),
      showFive ? buildFive(showFiveDelta, fiveBarWidth) : "",
      showSeven ? buildSeven(showSevenDelta, sevenBarWidth) : "",
    ]);
  };

  if (!maxWidth) return tryBuild(true, true, true, true, true);

  // 1. 完整顯示
  let line = tryBuild(true, true, true, true, true);
  if (visibleLength(line) <= maxWidth) return line;

  // 2. 隱藏 token 數
  line = tryBuild(false, true, true, true, true);
  if (visibleLength(line) <= maxWidth) return line;

  // 3. 隱藏 time delta
  line = tryBuild(false, false, false, true, true);
  if (visibleLength(line) <= maxWidth) return line;

  // 4. 隱藏 7d 用量
  line = tryBuild(false, false, false, false, true);
  if (visibleLength(line) <= maxWidth) return line;

  // 5. 隱藏 5h 用量
  line = tryBuild(false, false, false, false, false);
  if (visibleLength(line) <= maxWidth) return line;

  // 6. 縮短 ctx bar (10→5)，移除 5h/7d bar
  line = tryBuild(false, false, false, false, false, 5);
  if (visibleLength(line) <= maxWidth) return line;

  // fallback: truncate
  return truncateAnsi(line, maxWidth);
}

// --- output ---
const termWidth = getTerminalWidth();
const maxWidth = termWidth ? termWidth - 6 - RIGHT_NOTIFICATION_RESERVE : null;
const line1 = buildLine1(model, dirName, branch, gitChanges, maxWidth);
const line2 = buildLine2(ctxData, fiveData, sevenData, usageStale, maxWidth);
process.stdout.write(line2 + reset + "\n" + line1);
