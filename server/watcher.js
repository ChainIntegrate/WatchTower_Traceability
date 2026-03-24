import { tryDecodeStandardTransfer } from "./decoders.js";
import { normalizeLog, attachFromTo } from "./normalizer.js";

const isAddr = (a) => /^0x[a-f0-9]{40}$/.test(String(a || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startWatcher({
  provider,
  store,
  io,
  contracts,
  depositSet,
  userWalletMap,
  pollIntervalMs,
  confirmations,
  startBlock,
  history,
  tg
}) {


  // --------------------
  // Setup
  // --------------------
  const addrToMeta = new Map(
    (contracts || []).map((c) => [String(c.address || "").toLowerCase(), c])
  );

  const watchAddresses = (contracts || [])
    .map((c) => String(c.address || "").toLowerCase().trim())
    .filter(isAddr);

  let running = true;
  let timer = null;

  // evita tick sovrapposti
  let tickInProgress = false;

  // cache block timestamps
  const blockTsCache = new Map(); // bn -> ts

  async function getBlockTs(bn) {
    if (blockTsCache.has(bn)) return blockTsCache.get(bn);
    const b = await provider.getBlock(bn);
    const ts = Number(b?.timestamp) || null;
    blockTsCache.set(bn, ts);

    // simple cache control
    if (blockTsCache.size > 2000) {
      const keys = Array.from(blockTsCache.keys()).slice(0, 500);
      for (const k of keys) blockTsCache.delete(k);
    }
    return ts;
  }

  function getSafeHead(head) {
    const minLag = Math.max(1, Number(confirmations || 0));
    return Math.max(0, head - minLag);
  }

  async function getBlockNumberSafe(attempts = 5) {
    let wait = 500;
    for (let i = 0; i < attempts; i++) {
      try {
        return await provider.getBlockNumber();
      } catch (e) {
        const msg = String(e?.message || e);
        io.emit("error", {
          message: `RPC getBlockNumber failed (${i + 1}/${attempts}): ${msg}`
        });
        await sleep(wait);
        wait = Math.min(8000, Math.floor(wait * 1.8));
      }
    }
    throw new Error("RPC unstable: getBlockNumber keeps failing");
  }

  function isRetryableRpcError(msg) {
    const m = String(msg || "").toLowerCase();
    return (
      m.includes("invalid block range") ||
      m.includes("invalid block range params") ||
      m.includes("limit") ||
      m.includes("too many") ||
      m.includes("rate") ||
      m.includes("429") ||
      m.includes("timeout") ||
      m.includes("server_error") ||
      m.includes("failed response") ||
      m.includes("gateway") ||
      m.includes("503") ||
      m.includes("econnreset") ||
      m.includes("etimedout")
    );
  }

  async function fetchLogsRange(fromBlock, toBlock) {
    let logs = [];

    // Query per singolo address (seriale per non saturare la RPC)
    for (const addr of watchAddresses) {
      if (!running) return null;
      if (!isAddr(addr)) continue;

      try {
        const part = await provider.getLogs({
          fromBlock,
          toBlock,
          address: addr
        });
        if (Array.isArray(part) && part.length) logs.push(...part);
      } catch (e) {
        const msg = String(e?.message || e);
        if (isRetryableRpcError(msg)) return "RETRY_RANGE";
        throw e;
      }

      // micro-pause per non “martellare”
      await sleep(80);
    }

    logs.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    return logs;
  }

  // --------------------
  // init lastSeenBlock
  // --------------------
  const head0 = await getBlockNumberSafe();
  let lastSeenBlock = startBlock;

  if (lastSeenBlock == null || Number.isNaN(Number(lastSeenBlock))) {
    lastSeenBlock = head0;
  } else {
    lastSeenBlock = Number(lastSeenBlock);
    if (lastSeenBlock > head0) lastSeenBlock = head0;
    if (lastSeenBlock < 0) lastSeenBlock = 0;
  }

  store.lastBlock = lastSeenBlock;

  // --------------------
  // tick
  // --------------------
  async function tick() {
    if (!running) return;

    const head = await getBlockNumberSafe();
    const safeHead = getSafeHead(head);

    // già in pari
    if (lastSeenBlock >= safeHead) {
      io.emit("scan:progress", {
        status: "idle",
        head,
        safeHead,
        lastProcessed: store.lastBlock ?? lastSeenBlock,
        fromBlock: null,
        toBlock: null
      });

      io.emit("head", {
        head: safeHead,
        lastProcessed: store.lastBlock ?? lastSeenBlock
      });
      return;
    }

    const fromBlock = lastSeenBlock + 1;
    const toBlock = safeHead;

    // --- parametri RPC-friendly ---
    let chunk = 200;          // default stabile su public RPC
    const CHUNK_MIN = 25;     // quando la RPC è in crisi, scendi qui
    const CHUNK_MAX = 200;    // NON risalire oltre (public RPC)
    let backoff = 800;        // backoff progressivo (ms)

    for (let start = fromBlock; start <= toBlock; ) {
      if (!running) return;

      const end = Math.min(toBlock, start + chunk - 1);

      io.emit("scan:progress", {
        status: "catching_up",
        head,
        safeHead,
        lastProcessed: store.lastBlock ?? lastSeenBlock,
        fromBlock: start,
        toBlock: end
      });

      const logsOrSignal = await fetchLogsRange(start, end);
      if (!running) return;

      if (logsOrSignal === "RETRY_RANGE") {
        const newChunk = Math.max(CHUNK_MIN, Math.floor(chunk / 2));
        if (newChunk !== chunk) chunk = newChunk;

        io.emit("error", {
          message: `RPC unstable/rate-limited. Reducing chunk to ${chunk}. Backoff=${backoff}ms. Retrying...`
        });

        await sleep(backoff);
        backoff = Math.min(15000, Math.floor(backoff * 1.7));
        continue; // riprova stesso start
      }

      // ok: reset backoff
      backoff = 800;

      const logs = logsOrSignal || [];

      for (const log of logs) {
        if (!running) return;

        const meta = addrToMeta.get(String(log.address).toLowerCase()) || null;
        const ts = await getBlockTs(log.blockNumber);

        let evt = normalizeLog({
          log,
          blockTimestampSec: ts,
          contractMeta: meta,
          depositSet,
          userWalletMap
        });

     const dec = tryDecodeStandardTransfer(evt.raw);
     if (evt.raw?.topic0 === "0x88421f4082130794f859685c51960485fb1de845d474a7ac31ca2c52a76f6308") {
  console.log("[TRC2 DEBUG] topic0 match, dec=", dec);
}



// 1) Transfer (come già fai)
if (dec?.name === "Transfer" && dec.from && dec.to) {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const from = String(dec.from).toLowerCase();
  const to   = String(dec.to).toLowerCase();

  let k = "TRANSFER";
  if (from === ZERO) k = "MINT";
  else if (to === ZERO) k = "BURN";

  evt = attachFromTo(evt, { from: dec.from, to: dec.to, amount: dec.amount, userWalletMap });
  evt.kind = k;

  // info extra (ok)
  evt.decoded = { name: "Transfer", schema: dec.schema || "standard", amount: dec.amount };
}

// 2) TRC2 custom events (ConformitySet, StatusChanged, Superseded…)
else if (dec?.schema === "trc2") {
  // lascia kind=LOG (così non rompi filtri), ma aggiungi campi utili
  evt.event  = dec.name || null;
  evt.schema = "trc2";

  // tokenId per TRC2 è bytes32 (topics[1])
  if (dec.tokenId) evt.tokenId = dec.tokenId;

  // salva payload decodificato per UI/debug
  evt.extra = { ...dec };
}



 store.push(evt);
try { history?.append?.(evt); } catch {}
io.emit("event", evt);
tg?.enqueue?.(evt);


      }

      // range OK: avanza
      store.lastBlock = end;
      io.emit("head", { head: safeHead, lastProcessed: store.lastBlock });

      // rialza chunk lentamente ma senza superare CHUNK_MAX
      if (chunk < CHUNK_MAX) chunk = Math.min(CHUNK_MAX, chunk + 25);

      start = end + 1;
    }

    lastSeenBlock = safeHead;
  }

  // --------------------
  // Loop
  // --------------------
  const intervalMs = Math.max(800, Number(pollIntervalMs || 2500));

  timer = setInterval(async () => {
    if (!running) return;
    if (tickInProgress) return;

    tickInProgress = true;
    try {
      await tick();
    } catch (e) {
      io.emit("error", {
        message: String(e?.message || e),
        stack: e?.stack ? String(e.stack) : null
      });
    } finally {
      tickInProgress = false;
    }
  }, intervalMs);

  // first head push
  try {
    io.emit("head", { head: await getBlockNumberSafe(), lastProcessed: lastSeenBlock });
  } catch {}

  return {
    stop: () => {
      running = false;
      if (timer) clearInterval(timer);
    },
    isRunning: () => running,
    lastProcessed: () => store.lastBlock ?? lastSeenBlock,
    getState: () => ({ watchAddresses, lastSeenBlock })
  };
}
