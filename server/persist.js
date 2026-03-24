import fs from "fs";
import path from "path";

/**
 * Stato unico in root progetto:
 * -> /opt/apps/wr_trc2/state.json
 */
const STATE_PATH = path.join(process.cwd(), "state.json");

function readRaw() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const j = JSON.parse(raw);
    return (j && typeof j === "object") ? j : {};
  } catch {
    return {};
  }
}

export function loadState() {
  const j = readRaw();

  const lastBlock = Number(j?.lastBlock);
  const watcherStartBlock = Number(j?.watcherStartBlock);

  return {
    lastBlock: Number.isFinite(lastBlock) ? lastBlock : null,
    watcherWanted: j?.watcherWanted === true,
    watcherStartBlock: Number.isFinite(watcherStartBlock) ? watcherStartBlock : null
  };
}

/**
 * Merge + write atomica.
 * Puoi passare lastBlock e/o watcherWanted e/o watcherStartBlock.
 */
export function saveStateAtomic(patch = {}) {
  const cur = readRaw();

  // normalizzazioni
  const next = { ...cur, ...patch };

  if ("lastBlock" in patch) {
    const v = Number(patch.lastBlock);
    next.lastBlock = Number.isFinite(v) ? v : null;
  } else if ("lastBlock" in cur) {
    const v = Number(cur.lastBlock);
    next.lastBlock = Number.isFinite(v) ? v : null;
  } else {
    next.lastBlock = null;
  }

  if ("watcherWanted" in patch) {
    next.watcherWanted = patch.watcherWanted === true;
  } else if ("watcherWanted" in cur) {
    next.watcherWanted = cur.watcherWanted === true;
  } else {
    next.watcherWanted = false;
  }

  if ("watcherStartBlock" in patch) {
    const v = Number(patch.watcherStartBlock);
    next.watcherStartBlock = Number.isFinite(v) ? v : null;
  } else if ("watcherStartBlock" in cur) {
    const v = Number(cur.watcherStartBlock);
    next.watcherStartBlock = Number.isFinite(v) ? v : null;
  } else {
    next.watcherStartBlock = null;
  }

  next.savedAt = Date.now();

  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}
