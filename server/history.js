import fs from "fs";
import path from "path";

function safeJsonParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Legge "la coda" di un file grande, senza caricarlo tutto.
 * Prende gli ultimi `maxLines` JSON (NDJSON).
 */
export function loadTailEvents(filePath, maxLines = 800) {
  if (!fs.existsSync(filePath)) return [];

  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;

    // Se file piccolo leggi tutto
    const CHUNK = 1024 * 256; // 256KB
    let pos = size;
    let buf = "";
    let lines = [];

    while (pos > 0 && lines.length <= maxLines + 50) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;

      const b = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, b, 0, readSize, pos);

      buf = b.toString("utf8") + buf;
      lines = buf.split("\n");
    }

    // Prendi le ultime righe non vuote
    const tail = lines.filter(Boolean).slice(-maxLines);
    const out = [];
    for (const ln of tail) {
      const ev = safeJsonParse(ln);
      if (ev) out.push(ev);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writer NDJSON con stream (più efficiente di appendFileSync ad ogni evento)
 */
export function createHistoryWriter({ dir, filename = "events.ndjson" }) {
  const filePath = path.join(dir, filename);

  // assicura directory
  fs.mkdirSync(dir, { recursive: true });

  const stream = fs.createWriteStream(filePath, { flags: "a" });
  let closed = false;

  function append(eventObj) {
    if (closed) return;
    // una riga JSON
    const line = JSON.stringify(eventObj) + "\n";
    stream.write(line);
  }

  function stop() {
    if (closed) return;
    closed = true;
    try { stream.end(); } catch {}
  }

  return { filePath, append, stop };
}
