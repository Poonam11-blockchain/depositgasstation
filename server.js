// server.js (stores RAW private keys when requested)
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");

// generator (your existing file)
const { generateWalletFromMnemonic } = require("./generateMultichainwallets"); // adjust path if needed

// Models
const Wallet = require("./src/models/Wallets"); // full-wallet model (if used)
const Address = require("./src/models/Wallets");     // single-chain addresses (raw private keys possible)

const app = express();
app.use(bodyParser.json());

// --- MongoDB connect ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/walletdb";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("Mongo connection error:", err);
    process.exit(1);
  });

// Helper: safe boolean from request
function truthy(v) {
  if (v === true || v === "true") return true;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    return s === "true" || s === "1";
  }
  return Boolean(v);
}

// POST /api/wallets
// Modes:
// - single-chain derive: provide { index, chain, save?, savePrivateKey? }
// - full-wallet generate & save: provide no 'chain' (use solIndex, encryptPrivateKeys ignored in this raw-key version)
app.post("/api/wallets", async (req, res) => {
  try {
    const body = req.body || {};
    const { mnemonic, solIndex, chain, index } = body;

    // ---- Mode A: single-chain derive (with optional save) ----
    if (chain) {
      if (index === undefined || index === null || isNaN(Number(index))) {
        return res.status(400).json({ error: "index is required and must be a number when chain is provided" });
      }

      const walletObj = generateWalletFromMnemonic(mnemonic || undefined, { index: Number(index) });
      const k = String(chain).toLowerCase();
      let out;
      if (k === "ethereum" || k === "evm" || k === "eth") {
        out = { chain: "ethereum", index: walletObj.index, address: walletObj.evm.address, path: walletObj.evm.path };
      } else if (k === "bsc" || k === "binance") {
        out = { chain: "bsc", index: walletObj.index, address: walletObj.bsc.address, path: walletObj.bsc.path };
      } else if (k === "tron") {
        out = { chain: "tron", index: walletObj.index, address: walletObj.tron.address, path: walletObj.tron.path };
      } else if (k === "btc" || k === "bitcoin") {
        out = { chain: "btc", index: walletObj.index, address: walletObj.btc.address, path: walletObj.btc.path };
      } else if (k === "solana" || k === "sol") {
        out = { chain: "solana", index: walletObj.index, address: walletObj.solana.address, path: walletObj.solana.path };
      } else {
        return res.status(400).json({ error: "unsupported chain", supported: ["ethereum","bsc","tron","btc","solana"] });
      }

      const save = truthy(body.save); // boolean
      if (save) {
        try {
          const userId = String(Date.now()); // replace with real authenticated user id if available

          // Derive raw private key for the requested chain (0x..., WIF, base58)
          let rawPriv;
          switch (out.chain) {
            case "ethereum":
            case "bsc":
              rawPriv = walletObj.evm && walletObj.evm.privateKey; // "0x..."
              break;
            case "tron":
              rawPriv = walletObj.tron && walletObj.tron.privateKey; // "0x..."
              break;
            case "btc":
              rawPriv = walletObj.btc && walletObj.btc.privateKey; // WIF
              break;
            case "solana":
              rawPriv = walletObj.solana && walletObj.solana.privateKey; // base58
              break;
          }

          // If client requests to save private key, store RAW private key directly (no encryption)
          const wantSavePrivateKey = truthy(body.savePrivateKey);

          let privateKeyToStore = undefined;
          if (wantSavePrivateKey) {
            if (!rawPriv) {
              // no private key available for this chain (unexpected)
              throw new Error("no_private_key_available_for_chain");
            }
            privateKeyToStore = String(rawPriv); // RAW plaintext saved to DB
          }

          const doc = await Address.create({
            userId,
            chain: out.chain,
            index: out.index,
            address: out.address,
            path: out.path,
            privateKey: privateKeyToStore, // RAW or undefined
            meta: { source: "derive-api", storedRaw: !!privateKeyToStore }
          });

          return res.status(201).json({
            success: true,
            saved: true,
            dbId: doc._id,
            derived: out,
            storedPrivateKey: !!privateKeyToStore
          });
        } catch (err) {
          console.error("Address save error:", err);
          return res.status(500).json({ error: "address_db_save_failed", details: err.message });
        }
      }

      // default: return derived only (no save)
      return res.json({ success: true, derived: out });
    }

    // ---- Mode B: full wallet generation & save (legacy) ----
    // Here we simply save the full wallet object into Wallets collection.
    // NOTE: this version will store raw private keys as-is in the Wallet document (dangerous).
    const walletObj = generateWalletFromMnemonic(mnemonic || undefined, { index: solIndex });

    // We intentionally store raw private keys directly (no encryption) because user requested that behavior.
    const toSave = JSON.parse(JSON.stringify(walletObj));

    console.log("DEBUG: full wallet doc to save (raw private keys):", JSON.stringify(toSave, null, 2));

    const doc = new Wallet(toSave);
    const saved = await doc.save();

    const response = {
      id: saved._id,
      userId: saved.userId,
      evm: { address: saved.evm.address, path: saved.evm.path },
      bsc: { address: saved.bsc.address, path: saved.bsc.path },
      tron: { address: saved.tron.address, path: saved.tron.path },
      btc: { address: saved.btc.address, path: saved.btc.path },
      solana: { address: saved.solana.address, path: saved.solana.path, index: saved.solana.index },
      createdAt: saved.createdAt,
    };

    return res.status(201).json({ message: "Wallet saved (raw keys)", wallet: response });
  } catch (err) {
    console.error("Error in /api/wallets:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

// Optional: GET wallet (no private keys returned)
app.get("/api/wallets/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await Wallet.findById(id).lean();
    if (!doc) return res.status(404).json({ error: "not found" });

    return res.json({
      id: doc._id,
      userId: doc.userId,
      evm: { address: doc.evm.address, path: doc.evm.path },
      bsc: { address: doc.bsc.address, path: doc.bsc.path },
      tron: { address: doc.tron.address, path: doc.tron.path },
      btc: { address: doc.btc.address, path: doc.btc.path },
      solana: { address: doc.solana.address, path: doc.solana.path, index: doc.solana.index },
      createdAt: doc.createdAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
