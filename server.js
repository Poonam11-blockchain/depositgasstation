// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");

// HD generator: MUST NOT return private keys
const { generateMultichainAddresses } = require("./generateMultichainwallets");
const { runChainSweep } = require("./SweeperMultitokens");
const Withdrawal = require("./src/models/withdrawalmodels");
const UserBalance = require("./src/models/userBalancemodels");


// Mongo model for addresses
const Address = require("./src/models/Wallets");

const app = express();
app.use(bodyParser.json());

// --- MongoDB connect ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/walletdb";

mongoose
  .connect(MONGO_URI)
  .then(() => console.log(" MongoDB connected"))
  .catch((err) => {
    console.error("Mongo connection error:", err);
    process.exit(1);
  });

 function truthy(v) {
  if (v === true || v === "true") return true;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.toLowerCase());
  return !!v;
}
/**
 * Map external coin (what client sends) -> internal chain name
 * We store chain as: "ethereum","bsc","polygon","tron","btc","solana"
 */
function mapCoinToChain(coin) {
  if (!coin) return null;
  const c = String(coin).toLowerCase();

  if (c === "eth" || c === "ethereum") return "ethereum";
  if (c === "bsc" || c === "binance") return "bsc";
  if (c === "polygon" || c === "matic") return "polygon";
  if (c === "tron") return "tron";
  if (c === "btc" || c === "bitcoin") return "btc";
  if (c === "sol" || c === "solana") return "solana";

  return null;
}

// ---- Address normalizer (same semantics you used before) ----
function normalizeTo(chain, to) {
  if (!to) return to;
  const c = String(chain).toLowerCase();

  // EVM chains only — lowercase
  const EVM_CHAINS = new Set(["ethereum", "bsc", "polygon"]);
  if (EVM_CHAINS.has(c)) return to.toLowerCase();

  // Solana, Tron, Bitcoin → do NOT modify
  return to;
}

/**
 * Get/allocate a single HD index per user.
 *
 * Rule:
 *  - If user already has ANY wallet, reuse that index.
 *  - Otherwise, allocate the next global index.
 *
 * This makes sure:
 *  - USER_123 has the same index on ALL chains.
 *  - ETH/BSC/Polygon share same EVM address (same key).
 */
async function getIndexForUser(userId) {
  // 1. Does this user already have any address?
  const existing = await Address.findOne({ userId })
    .sort({ index: 1 })
    .lean();

  if (existing) {
    // Reuse that index across all chains for this user
    return existing.index;
  }

  // 2. Otherwise, allocate a new global index
  const last = await Address.findOne().sort({ index: -1 }).lean();
  return last ? last.index + 1 : 0;
}
/**
 * Liminal-style create wallet
 *
 * POST /api/onboarding/create-wallet
 *
 * Body:
 * {
 *   "userId": "USER_123",
 *   "wallet": {
 *     "coin": "eth",
 *     "walletType": "deposit",
 *     "name": "Ethereum Deposit"
 *   }
 * }
 */
app.post("/api/onboarding/create-wallet", async (req, res) => {
  try {
    const { userId, wallet } = req.body || {};

    // We need user id to map wallets to user
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    if (!wallet || !wallet.coin || !wallet.walletType) {
      return res.status(400).json({
        error: "wallet.coin and wallet.walletType are required",
      });
    }

    const { coin, walletType, name } = wallet;

    // For now we only support deposit wallets (like Liminal hot deposit wallets)
    if (walletType !== "deposit") {
      return res.status(400).json({
        error: "only walletType='deposit' is supported in this endpoint",
      });
    }

    const chain = mapCoinToChain(coin);
    if (!chain) {
      return res.status(400).json({
        error: "unsupported coin",
        supported: ["eth", "bsc", "polygon", "tron", "btc", "solana"],
      });
    }

    // IMPORTANT: get per-user index (same for all chains for this user)
    const index = await getIndexForUser(userId);

    // Derive all chains for this index using the HD generator
    // This MUST NOT expose private keys
    const multi = generateMultichainAddresses({ userId, index });

    // Pick the chain object (eth/bsc/polygon/tron/btc/solana)
    const chainObj = Object.values(multi.chains).find(
      (c) => c.chain === chain
    );

    if (!chainObj) {
      return res.status(500).json({ error: "chain derivation failed" });
    }

    function normalizeAddress(chain, address) {
  if (!address) return address;

  // EVM & BTC: normalize to lowercase for easy comparison
  if (["ethereum", "bsc", "polygon", "btc"].includes(chain)) {
    return address.toLowerCase();
  }

  // Tron: either keep original case or normalize consistently everywhere
  // If you want to keep code simple, you can lowercase here but
  // then make sure monitors also use .toLowerCase() before comparing.
  if (chain === "tron") {
    return address;   // or just `return address;` if you prefer
  }

  // Solana: NEVER lowercase – base58 is case-sensitive
  if (chain === "solana") {
    return address;                 // keep as generated
  }

  return address;
}

    // Save a single Address document for this wallet
    // const doc = await Address.create({
    //   userId,
    //   chain: chainObj.chain,
    //   index: multi.index,
    //   address: chainObj.address.toLowerCase(),
    //   path: chainObj.path,
    //   meta: {
    //     walletType,
    //     name,
    //     source: "liminal-style-create-wallet",
    //   },
    // });
         const doc = await Address.create({
         userId,
         chain: chainObj.chain,
         index: multi.index,
         address: normalizeAddress(chainObj.chain, chainObj.address),
         path: chainObj.path,
         meta: {
         walletType,
         name,
         source: "liminal-style-create-wallet",
         },
         });

    return res.status(201).json({
      success: true,
      wallet: {
        id: doc._id,
        userId: doc.userId,
        coin,           // as requested ("eth","bsc", etc.)
        walletType,     // "deposit"
        name,           // e.g. "Ethereum Deposit"
        chain: doc.chain,
        address: doc.address,
        index: doc.index,
        path: doc.path,
        createdAt: doc.createdAt,
      },
    });
  } catch (err) {
    console.error("Error in POST /api/onboarding/create-wallet:", err);
    return res.status(500).json({ error: err.message || "internal error" });
  }
});

app.get("/api/wallets/user/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;

    const docs = await Address.find({ userId }).lean();

    return res.json({
      userId,
      wallets: docs.map((d) => ({
        id: d._id,
        chain: d.chain,
        address: d.address,
        index: d.index,
        path: d.path,
        meta: d.meta,
        createdAt: d.createdAt,
      })),
    });
  } catch (err) {
    console.error("Error in GET /api/wallets/user/:userId:", err);
    res.status(500).json({ error: "internal error" });
  }
});

/**
 * Sweep API – calls the sweeping engine from SweeperMultitokens.js
 *
 * POST /api/sweep
 * {
 *   "chain": "ethereum" | "bsc" | "polygon" | "tron" | "btc" | "solana",
 *   "force": true/false    // optional
 * }
 */
app.post("/api/sweep", async (req, res) => {
  try {
    const body = req.body || {};
    const chain = (body.chain || "").toLowerCase();
    const force = truthy(body.force);

    if (
      !chain ||
      !["ethereum", "bsc", "tron", "btc", "solana", "polygon"].includes(chain)
    ) {
      return res.status(400).json({
        error: "chain required: ethereum|bsc|tron|btc|solana|polygon",
      });
    }

    console.log(`Received sweep request: chain=${chain} force=${force}`);
    const result = await runChainSweep(chain, { force });

    return res.json({ ok: true, result });
  } catch (err) {
    console.error("Error in POST /api/sweep:", err.stack || err.message || err);
    return res.status(500).json({ error: err.message || "internal error" });
  }
});

// ==================== WITHDRAWAL API (Liminal-style) ====================

/**
 * POST /withdrawals
 * Body: {
 *   chain: "ethereum"|"bsc"|"polygon"|"tron"|"bitcoin"|"btc"|"solana",
 *   symbol: "USDT"|"ETH"|...,
 *   to: "destinationAddress",
 *   amount: 1.23
 * }
 *
 * - Only creates a withdrawal request
 * - No on-chain transaction here
 * - Custody/approval engine will process later
 */


app.post("/withdrawals", async (req, res) => {
  try {
    const {
      chain: chainArg,
      symbol: symbolArg,
      to: toArg,
      amount: amountRaw,
    } = req.body || {};

    if (!chainArg || !symbolArg || !toArg || typeof amountRaw === "undefined") {
      return res
        .status(400)
        .json({ error: "chain, symbol, to, amount are required" });
    }

    const chain = String(chainArg).toLowerCase();
    const symbol = String(symbolArg).toUpperCase();
    const to = normalizeTo(chain, toArg);
    const amount = parseFloat(amountRaw);

    if (!to) {
      return res.status(400).json({ error: "invalid destination address" });
    }
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "invalid amount" });
    }

    // Check user balance in your DB
    // NOTE: this currently checks by { address: to, chain, symbol }
    const userBalance = await UserBalance.findOne({ address: to, chain, symbol });
    if (!userBalance || userBalance.balance < amount) {
      return res.status(400).json({ error: "insufficient balance in database" });
    }

    // ---- Liminal-style policy auto approval ----
    const NATIVE_SYMBOLS = new Set(["ETH", "BNB", "MATIC", "TRX", "BTC", "SOL"]);
    const NATIVE_THRESHOLD = 0.001; // native < 0.001 auto-approved
    const TOKEN_THRESHOLD = 50;     // tokens < 50 auto-approved

    const isNative = NATIVE_SYMBOLS.has(symbol);
    const isAutoApproved = isNative
      ? amount < NATIVE_THRESHOLD
      : amount < TOKEN_THRESHOLD;

    const status = isAutoApproved
      ? "auto_approved"          // policy says OK, waiting custody engine to process it
      : "pending_admin_review";  // needs manual admin approval

    const now = new Date();
    const withdrawal = await Withdrawal.create({
      chain,
      symbol,
      to,
      amount,
      status,
      isApproved: isAutoApproved,
      createdAt: now,
      updatedAt: now,
    });

    return res.status(201).json({
      message: isAutoApproved
        ? "withdrawal created (auto-approved by policy, will be processed by custody engine)"
        : "withdrawal created (awaiting admin approval)",
      withdrawal,
    });
  } catch (err) {
    console.error("POST /withdrawals error:", err);
    return res.status(500).json({
      error: "internal server error",
      details: err.message || String(err),
    });
  }
});

// Simple status lookup
app.get("/withdrawals/:id", async (req, res) => {
  try {
    const w = await Withdrawal.findById(req.params.id);
    if (!w) return res.status(404).json({ error: "not found" });
    return res.json(w);
  } catch (err) {
    console.error("GET /withdrawals/:id error:", err);
    return res.status(500).json({
      error: "internal error",
      details: err.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wallet server listening on ${PORT}`));

module.exports = app;
