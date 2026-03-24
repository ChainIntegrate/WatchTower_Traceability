// server/state.js
import fs from "fs";
import path from "path";

const STATE_PATH = process.env.WT_STATE_PATH
  ? path.resolve(process.env.WT_STATE_PATH)
  : path.join(process.cwd(), "state.json");


const DEFAULT_STATE = {
  scanning: false,
  mode: "live",        // "live" | "range"
  startBlock: null,    // numero o null
  lastStartAt: null,   // ISO string
  lastStopAt: null,    // ISO string
  lastReason: null     // "ui" | "boot" | "crash" | ...
};

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const s = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...s };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(next) {
  ensureDir(STATE_PATH);
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), "utf-8");
}

export function patchState(patch) {
  const cur = loadState();
  const next = { ...cur, ...patch };
  saveState(next);
  return next;
}

export function getStatePath() {
  return STATE_PATH;
}
