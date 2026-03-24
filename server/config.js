export const APP_NAME = "LUKSO WT_TRC2";
export const PORT = process.env.PORT ? Number(process.env.PORT) : 3010;

// RPC mainnet (HTTP)
export const RPC_URL = process.env.RPC_URL || "https://rpc.testnet.lukso.network";

// Buffer eventi in RAM
export const BUFFER_MAX = process.env.BUFFER_MAX ? Number(process.env.BUFFER_MAX) : 5000;

// Polling
export const POLL_INTERVAL_MS = process.env.POLL_INTERVAL_MS ? Number(process.env.POLL_INTERVAL_MS) : 2500;
export const CONFIRMATIONS = process.env.CONFIRMATIONS ? Number(process.env.CONFIRMATIONS) : 0; // 0 = realtime (meno “safe”), 1+ = più stabile

// Se vuoi partire da un blocco fisso, imposta env START_BLOCK
export const START_BLOCK = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null;

const a = (x) => String(x || "").toLowerCase();

/* ===== Watch contracts (deduplicati “a mano” già ok) ===== */
export const WATCH_CONTRACTS = [
  { key:"traceability_v2", label:"Traceability v2", address:a("0xbF8bc6982326fEA71e9A0f4891893B153F0Eb1a8") }
];


// (opzionale) deposit targets: quando avrai i vault, li metti qui
export const DEPOSIT_ADDRESSES = new Set([
  // a("0x...."),
]);

// (futuro) userWalletMap: label/ruoli agli address
export const USER_WALLET_MAP = {
  // [a("0x...")]: { label:"Fabio", group:"clienti" }
};

export const BLOCKSCOUT_BASE =
  process.env.BLOCKSCOUT_BASE ||
  "https://explorer.execution.testnet.lukso.network";


// --- Telegram (optional) ---
let local = {};
try {
  // import dinamico per non rompere se il file non esiste
  local = await import("./secrets.local.js");
} catch {}

export const TG_ENABLED =
  (process.env.TG_ENABLED ? String(process.env.TG_ENABLED).toLowerCase() === "true" : null)
  ?? (local.TG_ENABLED ?? false);

export const TG_BOT_TOKEN =
  process.env.TG_BOT_TOKEN
  ?? local.TG_BOT_TOKEN
  ?? "";

export const TG_CHAT_ID =
  process.env.TG_CHAT_ID
  ?? local.TG_CHAT_ID
  ?? "";

export const TG_MIN_INTERVAL_MS =
  process.env.TG_MIN_INTERVAL_MS ? Number(process.env.TG_MIN_INTERVAL_MS) : 1500;

// filtri opzionali (se ti serviranno dopo)
export const TG_ALLOW_SCHEMAS = process.env.TG_ALLOW_SCHEMAS || "";
export const TG_ALLOW_KINDS = process.env.TG_ALLOW_KINDS || "";
export const TG_ALLOW_CONTRACTS = process.env.TG_ALLOW_CONTRACTS || "";
