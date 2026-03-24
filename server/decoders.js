// server/decoders.js
import { ethers } from "ethers";

const { defaultAbiCoder, hexDataSlice } = ethers.utils;

/**
 * Nota importante:
 * - ERC20 Transfer e ERC721 Transfer hanno LO STESSO topic0:
 *   keccak256("Transfer(address,address,uint256)") = 0xddf252...
 * - Li distinguiamo guardando:
 *   - ERC20: topics.length === 3 e data contiene uint256
 *   - ERC721: topics.length === 4 e tokenId è topics[3], data spesso "0x"
 */

const TOPIC_TRANSFER_ERC20_OR_ERC721 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// LSP7 Transfer topic0 (due varianti viste in giro)
const TOPIC_LSP7_TRANSFER_V1 =
  "0x3997e418d2cef0b3b0e907b1e39605c3f7d32dbd061e82ea5b4a770d46a160a6";
const TOPIC_LSP7_TRANSFER_V0 =
  "0xf8e1a15aba9398e019f0b49df1a4fde98ee17ae345cb5f6b5e2c27f5033e8ce7";

// --- TRC2 custom events (calcolo topic0 da firma) ---
const TOPIC_TRC2_CONFORMITY_SET = ethers.utils.id(
  "ConformitySet(bytes32,bytes32,bytes32,uint256)"
);
const TOPIC_TRC2_STATUS_CHANGED = ethers.utils.id(
  "ConformityStatusChanged(bytes32,uint8)"
);
const TOPIC_TRC2_CERT_SUPERSEDED = ethers.utils.id(
  "CertificateSuperseded(bytes32,bytes32)"
);
const TOPIC_TRC2_CONFORMITY_FROZEN = ethers.utils.id("ConformityFrozen()");
const TOPIC_TRC2_METADATA_FROZEN = ethers.utils.id("MetadataFrozen()");

function topicToAddress(t) {
  if (!t) return null;
  const hex = String(t);
  if (!hex.startsWith("0x") || hex.length !== 66) return null;
  return "0x" + hex.slice(26);
}

function topicToBytes32(t) {
  if (!t) return null;
  const hex = String(t);
  if (!hex.startsWith("0x") || hex.length !== 66) return null;
  return hex.toLowerCase();
}

export function tryDecodeStandardTransfer(log) {
  const topic0 = (log?.topics?.[0] || log?.topic0 || "").toLowerCase();

  // -------------------------
  // ERC20 / ERC721 Transfer (stesso topic0)
  // -------------------------
  if (topic0 === TOPIC_TRANSFER_ERC20_OR_ERC721) {
    const topics = log.topics || [];
    const data = (log.data || "0x").toLowerCase();

    // ERC721-style: 4 topics (sig, from, to, tokenId) e data spesso vuota
    if (topics.length >= 4) {
      const from = topicToAddress(topics[1]);
      const to = topicToAddress(topics[2]);
      const tokenIdTopic = topics[3]; // 32 bytes

      let tokenId = null;
      try {
        tokenId = ethers.BigNumber.from(tokenIdTopic).toString();
      } catch {}

      return {
        name: "Transfer",
        schema: "erc721", // per LSP8 va benissimo (è compatibile ERC721 a livello eventi)
        from,
        to,
        tokenId,          // decimale (comodo)
        tokenIdTopic: topicToBytes32(tokenIdTopic) // hex 32 bytes (comodo per mapping bytes32)
      };
    }

    // ERC20-style: 3 topics (sig, from, to) + data uint256
    const from = topicToAddress(topics[1]);
    const to = topicToAddress(topics[2]);

    let amount = null;
    try {
      const [amt] = defaultAbiCoder.decode(["uint256"], log.data || "0x");
      amount = amt?.toString?.() ?? String(amt);
    } catch {}

    return { name: "Transfer", schema: "erc20", from, to, amount };
  }

  // -------------------------
  // LSP7 Transfer
  // -------------------------
  if (topic0 === TOPIC_LSP7_TRANSFER_V1 || topic0 === TOPIC_LSP7_TRANSFER_V0) {
    const operator = topicToAddress(log.topics?.[1]);
    const from = topicToAddress(log.topics?.[2]);
    const to = topicToAddress(log.topics?.[3]);

    let amount = null;
    let force = null;

    try {
      const decoded = defaultAbiCoder.decode(
        ["uint256", "bool", "bytes"],
        log.data || "0x"
      );
      amount = decoded?.[0]?.toString?.() ?? String(decoded?.[0]);
      force = Boolean(decoded?.[1]);
    } catch {
      try {
        const a = hexDataSlice(log.data || "0x", 0, 32);
        amount = ethers.BigNumber.from(a).toString();
      } catch {}
    }

    return { name: "Transfer", schema: "lsp7", operator, from, to, amount, force };
  }

  // -------------------------
  // TRC2: ConformitySet
  // event ConformitySet(bytes32 indexed tokenId, bytes32 indexed certificateId, bytes32 documentHash, uint256 issuedAt)
  // topics: [sig, tokenId, certificateId]
  // data: (documentHash, issuedAt)
  // -------------------------
  if (topic0 === TOPIC_TRC2_CONFORMITY_SET.toLowerCase()) {
    const tokenId = topicToBytes32(log.topics?.[1]);
    const certificateId = topicToBytes32(log.topics?.[2]);

    let documentHash = null;
    let issuedAt = null;

    try {
      const [docHash, ts] = defaultAbiCoder.decode(
        ["bytes32", "uint256"],
        log.data || "0x"
      );
      documentHash = String(docHash).toLowerCase();
      issuedAt = (ts?.toString?.() ?? String(ts));
    } catch {}

    return {
      name: "ConformitySet",
      schema: "trc2",
      tokenId,
      certificateId,
      documentHash,
      issuedAt
    };
  }

  // -------------------------
  // TRC2: ConformityStatusChanged
  // event ConformityStatusChanged(bytes32 indexed tokenId, CertStatus status)
  // data: uint8 status
  // -------------------------
  if (topic0 === TOPIC_TRC2_STATUS_CHANGED.toLowerCase()) {
    const tokenId = topicToBytes32(log.topics?.[1]);

    let status = null;
    try {
      const [st] = defaultAbiCoder.decode(["uint8"], log.data || "0x");
      status = Number(st);
    } catch {}

    return {
      name: "ConformityStatusChanged",
      schema: "trc2",
      tokenId,
      status
    };
  }

  // -------------------------
  // TRC2: CertificateSuperseded
  // event CertificateSuperseded(bytes32 indexed oldTokenId, bytes32 indexed newTokenId)
  // topics: [sig, old, new]
  // -------------------------
  if (topic0 === TOPIC_TRC2_CERT_SUPERSEDED.toLowerCase()) {
    const oldTokenId = topicToBytes32(log.topics?.[1]);
    const newTokenId = topicToBytes32(log.topics?.[2]);

    return {
      name: "CertificateSuperseded",
      schema: "trc2",
      oldTokenId,
      newTokenId
    };
  }

  // -------------------------
  // TRC2: Frozen events (no params)
  // -------------------------
  if (topic0 === TOPIC_TRC2_CONFORMITY_FROZEN.toLowerCase()) {
    return { name: "ConformityFrozen", schema: "trc2" };
  }
  if (topic0 === TOPIC_TRC2_METADATA_FROZEN.toLowerCase()) {
    return { name: "MetadataFrozen", schema: "trc2" };
  }

  return null;
}
