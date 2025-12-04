// withdrawalHandler.js (Liminal-style client-facing API)
require("dotenv").config();

const Withdrawal = require("./src/models/withdrawalmodels");
const UserBalance = require("./src/models/userBalancemodels");



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
 * POST /withdrawals
 * Body: {
 *   chain: "ethereum"|"bsc"|"polygon"|"tron"|"bitcoin"|"btc"|"solana",
 *   symbol: "USDT"|"ETH"|...,
 *   to: "destinationAddress",
 *   amount: 1.23
 * }
 *
 * This is Liminal-style:
 *  - It NEVER sends on-chain
 *  - It only creates a withdrawal request
 *  - Actual signing/broadcasting is done by the custody/approval service
 */
app.post("/withdrawals", async (req, res) => {
  try {
    const {
      chain: chainArg,
      symbol: symbolArg,
      to: toArg,
      amount: amountRaw,
    } = req.body;

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

    // Check user balance in your DB (same as your old code)
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

    const withdrawal = await Withdrawal.create({
      chain,
      symbol,
      to,
      amount,
      status,
      isApproved: isAutoApproved,      // true if policy auto-approved
      createdAt: new Date(),
      updatedAt: new Date(),
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
    return res.status(500).json({ error: "internal error", details: err.message || String(err) });
  }
});

