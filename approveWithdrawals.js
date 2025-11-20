// approveWithdrawals-api.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { ethers } = require("ethers");
const TronWeb = require("tronweb");
const mongoose = require("mongoose");
const bitcoin = require("bitcoinjs-lib");
const axios = require("axios");
const { ECPairFactory } = require("ecpair");
const tinysecp = require("tiny-secp256k1")
const ECPair = ECPairFactory(tinysecp);

// your models + helpers (ensure these paths exist)
const Withdrawal = require("./src/models/withdrawalmodels");
const Transaction = require("./src/models/transactionmodels");
const UserBalance = require("./src/models/userBalancemodels");

// ---- config ----
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim(); // must be set in .env
const PORT = process.env.APP_PORT || 6000;

const app = express();
app.use(bodyParser.json());

// ---- DB helper ----
async function ensureDb() {
  if (mongoose.connection.readyState === 1) return;
  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) throw new Error("MONGO_URI missing in env");
  // avoid deprecated options
  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB (approve API) connected");
}

// ---- small mask util for logs ----
function mask(s){
  if (!s) return "MISSING";
  const t = String(s).trim();
  return t.length > 10 ? `${t.slice(0,6)}...${t.slice(-4)}` : t;
}

// ---- admin auth middleware (accepts header OR query param) ----
function adminAuth(req, res, next) {
  // prefer header, fallback to query param
  const headerKey = (req.headers["x-admin-key"] || req.headers["x-api-key"] || "").toString().trim();
  const queryKey = (req.query && (req.query["x-admin-key"] || req.query["x-api-key"]) || "").toString().trim();
  const provided = headerKey || queryKey;

  if (!ADMIN_KEY) {
    console.error("ADMIN_KEY not set in process.env - blocking access");
    return res.status(401).json({ error: "Admin key not configured on server" });
  }

  console.log(`adminAuth: incoming=${mask(provided)} server=${mask(ADMIN_KEY)}`);

  if (!provided) return res.status(403).json({ error: "forbidden - missing key" });
  if (provided !== ADMIN_KEY) return res.status(403).json({ error: "forbidden - invalid key" });
  next();
}

// ---- process single withdrawal (uses your on-chain helpers) ----
async function processWithdrawal(withdrawal) {
  const { _id, chain, symbol, to, amount } = withdrawal;
  const normalizedTo = chain === "tron" ? to : (to || "").toLowerCase();

  // set approved first
  await Withdrawal.findByIdAndUpdate(_id, { isApproved: true });

  try {
    // choose helper (these functions must be in scope - see below)
    const symUp = (symbol || "").toString().toUpperCase();
    const chainLower = (chain || "").toString().toLowerCase();

    if (chainLower === "tron") {
      if (symUp === "TRX") {
        await tronNativeWithdraw(to, amount);
      } else {
        await tronWithdraw(symbol, to, amount);
      }
    } else if (chainLower === "bitcoin" || chainLower === "btc") {
      await btcWithdraw(symbol, to, amount);
    } else {
      // polygon/ethereum/bsc flows
      if (chainLower === "polygon") {
        if (symUp === "MATIC") {
          await polygonNativeWithdraw(to, amount);
        } else {
          await polygonWithdraw(symbol, to, amount);
        }
      } else {
        if (symUp === "ETH" || symUp === "BNB") {
          await evmNativeWithdraw(chainLower, symbol, to, amount);
        } else {
          await evmWithdraw(chainLower, symbol, to, amount);
        }
      }
    }

    // success -> mark completed + adjust user balance
    await Withdrawal.findByIdAndUpdate(_id, { status: "completed" });
    await UserBalance.findOneAndUpdate(
      { address: normalizedTo, chain, symbol },
      { $inc: { balance: -parseFloat(amount) } }
    );

    return { id: _id.toString(), ok: true };
  } catch (err) {
    console.error(`processWithdrawal(${_id}) failed:`, err && (err.stack || err.message || err));
    await Withdrawal.findByIdAndUpdate(_id, { status: "failed" });
    return { id: _id.toString(), ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// ---- approvePendingLarge implementation (no auto-run) ----
// unified: tokens >= 50; native coins >= 0.001
let _approvePendingLargeInProgress = false;
async function approvePendingLarge(limit = 100) {
  if (_approvePendingLargeInProgress) {
    console.log("approvePendingLarge: run in progress, refusing concurrent execution.");
    return { processed: 0, details: [], note: "concurrent_run" };
  }
  _approvePendingLargeInProgress = true;

  try {
    await ensureDb();

    // fetch candidates (we pull more to let JS-side filter handle string amounts)
    const fetchLimit = Math.max(limit * 3, 100);
    const pending = await Withdrawal.find({ isApproved: false }).limit(fetchLimit).lean();

    if (!pending || !pending.length) {
      console.log("⚠️ No pending large withdrawals found.");
      return { processed: 0, details: [] };
    }

    // native symbols set (uppercase)
    const nativeSet = new Set(["ETH", "BNB", "MATIC", "TRX", "BTC"]);

    // thresholds
    const tokenThreshold = 50;
    const nativeThreshold = 0.001;

    // pick candidates based on symbol and amount (string amounts handled)
    const candidates = [];
    for (const w of pending) {
      const sym = (w.symbol || "").toString().toUpperCase();
      const amt = parseFloat(w.amount);
      if (isNaN(amt)) {
        console.warn(`Skipping withdrawal ${w._id} due to invalid amount: ${w.amount}`);
        continue;
      }

      if (nativeSet.has(sym)) {
        if (amt >= nativeThreshold) candidates.push(w);
      } else {
        if (amt >= tokenThreshold) candidates.push(w);
      }

      if (candidates.length >= limit) break;
    }

    if (!candidates.length) {
      console.log("⚠️ No matching large or native pending withdrawals found after filter.");
      return { processed: 0, details: [] };
    }

    const results = [];
    for (const w of candidates) {
      console.log(`Approving pending withdrawal ${w._id} ${w.amount} ${w.symbol} -> ${w.to} (${w.chain})`);
      try {
        const r = await processWithdrawal(w);
        results.push(r);
      } catch (err) {
        console.error(`Error processing withdrawal ${w._id}:`, err && (err.stack || err.message || err));
        results.push({ id: w._id.toString(), ok: false, error: err && err.message ? err.message : String(err) });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    return { processed: results.length, succeeded, failed: results.length - succeeded, details: results };
  } finally {
    _approvePendingLargeInProgress = false;
  }
}

// ---- Routes ----
app.post("/api/approve-pending-large", adminAuth, async (req, res) => {
  try {
    await ensureDb();

    // safe read: prefer body.limit, fallback to query.limit, then default 100
    const rawLimit = (req && req.body && typeof req.body.limit !== "undefined")
      ? req.body.limit
      : (req && req.query && typeof req.query.limit !== "undefined")
        ? req.query.limit
        : undefined;

    const limit = Number(rawLimit) > 0 ? Number(rawLimit) : 100;

    console.log(`approve-pending-large called (limit source: ${req.body && typeof req.body.limit !== "undefined" ? "body" : (req.query && typeof req.query.limit !== "undefined" ? "query" : "default")}, limit=${limit})`);

    // unified implementation call (handles tokens >=50 and native >=0.001)
    const result = await approvePendingLarge(limit);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("approve-pending-large error:", err && (err.stack || err.message || err));
    return res.status(500).json({ error: "internal error", details: err.message || String(err) });
  }
});

app.post("/api/withdrawals/:id/approve", adminAuth, async (req, res) => {
  try {
    await ensureDb();
    const id = req.params.id;
    const w = await Withdrawal.findById(id);
    if (!w) return res.status(404).json({ error: "not found" });
    if (w.isApproved) return res.status(400).json({ error: "already approved" });

    const result = await processWithdrawal(w);
    if (result.ok) return res.json({ ok: true, id: result.id });
    return res.status(500).json({ ok: false, id: result.id, error: result.error });
  } catch (err) {
    console.error("single approve error:", err && (err.stack || err.message || err));
    return res.status(500).json({ error: "internal error", details: err.message || String(err) });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- Server start only when run directly (no auto-run of approvals) ----
if (require.main === module) {
  ensureDb().catch(e => {
    console.error("DB connection failed:", e && (e.stack || e.message || e));
    process.exit(1);
  });

  app.listen(PORT, () => console.log(`✅ Approve API listening on ${PORT}`));
}

module.exports = { app, approvePendingLarge };

// ------------------- on-chain helpers (unchanged) -------------------

async function evmWithdraw(chain, symbol, to, amountRaw) {
  const tokens = require(`./token${chain}.json`);
  const erc20Abi = require("./erc20.json");

  const tokenInfo = tokens.find(t => t.symbol === symbol);
  if (!tokenInfo) throw new Error(`Token ${symbol} not found in token${chain}.json`);

  const provider = new ethers.providers.JsonRpcProvider(
    chain === "ethereum" ? process.env.ETH_NODE_URL : process.env.BSC_NODE_URL
  );

  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS);
  const mainAdminKey = adminKeys[0];
  const mainAdminWallet = new ethers.Wallet(mainAdminKey, provider);
  const token = new ethers.Contract(tokenInfo.address, erc20Abi, mainAdminWallet);
  const amount = ethers.utils.parseUnits(amountRaw, tokenInfo.decimals);

  const adminBalance = await token.balanceOf(mainAdminWallet.address);
  if (adminBalance.lt(amount)) {
    for (let i = 1; i < adminKeys.length; i++) {
      const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
      const fallbackToken = new ethers.Contract(tokenInfo.address, erc20Abi, fallbackWallet);
      const fallbackBalance = await fallbackToken.balanceOf(fallbackWallet.address);
      if (fallbackBalance.gte(amount)) {
        const tx = await fallbackToken.transfer(mainAdminWallet.address, amount);
        await tx.wait();
        break;
      }
    }
  }

  const tx = await token.transfer(to, amount);
  await tx.wait();

  await Transaction.create({
    chain,
    type: "withdrawal",
    symbol,
    from: mainAdminWallet.address,
    to,
    amount: amountRaw,
    txHash: tx.hash,
  });
}

////native currency ETH/BNB
async function evmNativeWithdraw(chain, symbol, to, amount) {
  const provider = new ethers.providers.JsonRpcProvider(
    chain === "ethereum" ? process.env.ETH_NODE_URL : process.env.BSC_NODE_URL
  );

  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS);
  const mainAdminWallet = new ethers.Wallet(adminKeys[0], provider);
  const value = ethers.utils.parseEther(amount.toString());

  let balance = await provider.getBalance(mainAdminWallet.address);
  if (balance.lt(value)) {
    for (let i = 1; i < adminKeys.length; i++) {
      const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
      const fallbackBalance = await provider.getBalance(fallbackWallet.address);
      if (fallbackBalance.gte(value)) {
        const refillTx = await fallbackWallet.sendTransaction({
          to: mainAdminWallet.address,
          value
        });
        console.log(`Refilled native from Admin${i + 1}: ${refillTx.hash}`);
        await refillTx.wait();
        break;
      }
    }
  }

  const tx = await mainAdminWallet.sendTransaction({
    to,
    value
  });

  await tx.wait();

  await Transaction.create({
    chain,
    type: "withdrawal",
    symbol,
    from: mainAdminWallet.address,
    to,
    amount: parseFloat(amount),
    txHash: tx.hash
  });

  console.log(`Native withdrawal complete: ${tx.hash}`);
}


// ---------------- POLYGON: ERC20 withdraw ----------------
async function polygonWithdraw(symbol, to, amountRaw) {
  const erc20Abi = require("./erc20.json");
  const tokens = require("./tokenpolygon.json");

  const tokenInfo = tokens.find(t => t.symbol === symbol);
  if (!tokenInfo) throw new Error(`Token ${symbol} not found in tokenpolygon.json`);

  const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_NODE_URL);
  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS_POLYGON || process.env.ADMIN_WALLETS_PRIVATE_KEYS);
  if (!Array.isArray(adminKeys) || !adminKeys.length) throw new Error("ADMIN_WALLETS_PRIVATE_KEYS_POLYGON (or ADMIN_WALLETS_PRIVATE_KEYS) missing");

  const mainAdminKey = adminKeys[0];
  const mainAdminWallet = new ethers.Wallet(mainAdminKey, provider);
  const token = new ethers.Contract(tokenInfo.address, erc20Abi, mainAdminWallet);
  const amount = ethers.utils.parseUnits(String(amountRaw), tokenInfo.decimals);

  // ensure token liquidity: if main admin lacks tokens, attempt refill from fallback admin token wallets
  let adminBalance = await token.balanceOf(mainAdminWallet.address);
  if (adminBalance.lt(amount)) {
    console.log(`⚠️ Main polygon admin token ${symbol} low. Attempting refill from fallbacks...`);
    let refilled = false;
    for (let i = 1; i < adminKeys.length; i++) {
      try {
        const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
        const fallbackToken = new ethers.Contract(tokenInfo.address, erc20Abi, fallbackWallet);
        const fallbackBal = await fallbackToken.balanceOf(fallbackWallet.address);
        if (BigInt(fallbackBal.toString()) >= BigInt(amount.toString())) {
          // ensure fallback has native MATIC to pay gas for token transfer
          const fallbackNative = await provider.getBalance(fallbackWallet.address);
          const estGasLimit = ethers.BigNumber.from(90000);
          const gasPrice = await provider.getGasPrice();
          const feeNeeded = estGasLimit.mul(gasPrice);
          if (fallbackNative.lt(feeNeeded)) {
            console.log(`⚠️ Fallback admin ${fallbackWallet.address} has insufficient MATIC for gas. Skipping.`);
            continue;
          }

          // transfer tokens from fallback to main admin
          const tx = await fallbackToken.transfer(mainAdminWallet.address, amount);
          console.log(`⛽ Refill token from fallback Admin${i + 1} tx: ${tx.hash}`);
          await tx.wait();
          refilled = true;
          break;
        }
      } catch (e) {
        console.warn(`⚠️ Refill attempt from Admin${i + 1} failed: ${e.message}`);
      }
    }

    // refresh adminBalance
    adminBalance = await token.balanceOf(mainAdminWallet.address);
    if (adminBalance.lt(amount)) {
      console.error("❌ No fallback polygon admin wallet has sufficient tokens.");
      throw new Error("No fallback polygon admin wallet has sufficient tokens.");
    }
    if (refilled) await new Promise(r => setTimeout(r, 1200)); // small wait after refill
  }

  // ensure main admin has MATIC to pay gas for the token transfer
  let gasLimit;
  try {
    gasLimit = await token.estimateGas.transfer(to, amount, { from: mainAdminWallet.address });
  } catch (e) {
    gasLimit = ethers.BigNumber.from(90000);
  }
  const gasPrice = await provider.getGasPrice();
  const feeNeeded = gasLimit.mul(gasPrice);
  let mainNativeBal = await provider.getBalance(mainAdminWallet.address);

  if (mainNativeBal.lt(feeNeeded)) {
    console.log("⚠️ Main polygon admin native MATIC low. Attempting native refill from fallbacks...");
    let refilledNative = false;
    for (let i = 1; i < adminKeys.length; i++) {
      try {
        const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
        const fallbackBalNative = await provider.getBalance(fallbackWallet.address);
        if (fallbackBalNative.gte(feeNeeded)) {
          const refillTx = await fallbackWallet.sendTransaction({ to: mainAdminWallet.address, value: feeNeeded });
          console.log(`⛽ Refilled main admin native from Admin${i + 1}: ${refillTx.hash}`);
          await refillTx.wait();
          refilledNative = true;
          break;
        }
      } catch (e) {
        console.warn(`⚠️ Native refill attempt from Admin${i + 1} failed: ${e.message}`);
      }
    }
    if (!refilledNative) {
      // still re-check; if still not enough, throw
      mainNativeBal = await provider.getBalance(mainAdminWallet.address);
      if (mainNativeBal.lt(feeNeeded)) {
        console.error("❌ No fallback polygon admin wallet has sufficient MATIC for gas.");
        throw new Error("No fallback polygon admin wallet has sufficient MATIC for gas.");
      }
    }
    await new Promise(r => setTimeout(r, 800));
  }

  // perform token transfer
  try {
    const tx = await token.transfer(to, amount, { gasLimit, gasPrice });
    console.log(`✅ Polygon token ${symbol} withdrawal tx: ${tx.hash}`);
    await tx.wait();

    await Transaction.create({
      chain: "polygon",
      type: "withdrawal",
      symbol,
      from: mainAdminWallet.address,
      to,
      amount: amountRaw,
      txHash: tx.hash,
    });
  } catch (err) {
    console.error(`❌ Polygon token withdrawal failed: ${err && err.message ? err.message : err}`);
    throw err;
  }
}

// --------------- POLYGON: native MATIC withdraw ----------------
async function polygonNativeWithdraw(to, amountRaw) {
  const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_NODE_URL);
  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS_POLYGON || process.env.ADMIN_WALLETS_PRIVATE_KEYS);
  if (!Array.isArray(adminKeys) || !adminKeys.length) throw new Error("ADMIN_WALLETS_PRIVATE_KEYS_POLYGON (or ADMIN_WALLETS_PRIVATE_KEYS) missing");

  const mainAdminKey = adminKeys[0];
  const mainAdminWallet = new ethers.Wallet(mainAdminKey, provider);
  const value = ethers.utils.parseEther(String(amountRaw));

  // check main admin native balance
  let mainBalance = await provider.getBalance(mainAdminWallet.address);
  if (mainBalance.lt(value)) {
    console.log("⚠️ Main polygon admin MATIC low. Attempting refill from fallbacks...");
    let refilled = false;
    for (let i = 1; i < adminKeys.length; i++) {
      try {
        const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
        const fallbackBal = await provider.getBalance(fallbackWallet.address);
        if (fallbackBal.gte(value)) {
          const refillTx = await fallbackWallet.sendTransaction({ to: mainAdminWallet.address, value });
          console.log(`⛽ Refilled MATIC from Admin${i + 1}: ${refillTx.hash}`);
          await refillTx.wait();
          refilled = true;
          break;
        }
      } catch (e) {
        console.warn(`⚠️ MATIC refill attempt from Admin${i + 1} failed: ${e.message}`);
      }
    }

    mainBalance = await provider.getBalance(mainAdminWallet.address);
    if (mainBalance.lt(value)) {
      console.error("❌ No fallback polygon admin wallet has sufficient MATIC for the withdrawal.");
      throw new Error("No fallback polygon admin wallet has sufficient MATIC for the withdrawal.");
    }
  }

  // perform native send
  try {
    const tx = await mainAdminWallet.sendTransaction({ to, value });
    console.log(`✅ Polygon native withdrawal tx: ${tx.hash}`);
    await tx.wait();

    await Transaction.create({
      chain: "polygon",
      type: "withdrawal",
      symbol: "MATIC",
      from: mainAdminWallet.address,
      to,
      amount: parseFloat(amountRaw),
      txHash: tx.hash,
    });
  } catch (err) {
    console.error(`❌ Polygon native withdrawal failed: ${err && err.message ? err.message : err}`);
    throw err;
  }
}

// ---------------- TRON: TRC20 withdraw ----------------
async function tronWithdraw(symbol, to, amountRaw) {
  const tokens = require("./tokentron.json");
  const trc20Abi = require("./trc20.json");
  const tokenInfo = tokens.find(t => t.symbol === symbol);
  if (!tokenInfo) {
    console.error(`❌ Token ${symbol} not found in tokentron.json`);
    return;
  }

  const amount = BigInt(parseFloat(amountRaw) * 10 ** tokenInfo.decimals).toString();
  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS_TRON); // must be array of PKs
  const tronWeb = new TronWeb({ fullHost: process.env.TRON_NODE_URL, privateKey: adminKeys[0] });
  const contract = await tronWeb.contract(trc20Abi, tokenInfo.address);

  const admin1Address = tronWeb.address.fromPrivateKey(adminKeys[0]);
  const admin1Balance = await contract.methods.balanceOf(admin1Address).call();

  if (BigInt(admin1Balance) < BigInt(amount)) {
    console.log(`⚠️ Admin1 balance low. Attempting refill...`);

    for (let i = 1; i < adminKeys.length; i++) {
      const fallbackTronWeb = new TronWeb({ fullHost: process.env.TRON_NODE_URL, privateKey: adminKeys[i] });
      const fallbackContract = await fallbackTronWeb.contract(trc20Abi, tokenInfo.address);
      const fallbackAddress = fallbackTronWeb.address.fromPrivateKey(adminKeys[i]);
      const fallbackBalance = await fallbackContract.methods.balanceOf(fallbackAddress).call();

      if (BigInt(fallbackBalance) >= BigInt(amount)) {
        const tx = await fallbackContract.methods.transfer(admin1Address, amount).send({
          feeLimit: 15_000_000,
        });
        console.log(`✅ Refilled ${amountRaw} ${symbol} from Admin${i + 1}: ${tx}`);
        break;
      }
    }

    const finalBalance = await contract.methods.balanceOf(admin1Address).call();
    if (BigInt(finalBalance) < BigInt(amount)) {
      console.error("❌ No fallback TRON admin wallet has sufficient tokens.");
      return;
    }
  }

  try {
    const tx = await contract.methods.transfer(to, amount).send({ feeLimit: 15_000_000 });
    await Transaction.create({
      chain: "tron",
      type: "withdrawal",
      symbol,
      from: admin1Address,
      to,
      amount: amountRaw,
      txHash: tx,
    });
    console.log("TRON Withdrawal complete & logged.");
  } catch (err) {
    console.error(`❌ TRON withdrawal failed:`, err.message);
  }
}
const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS_TRON); // [pk1, pk2, pk3...]

function getTronWeb(privateKey) {
  return new TronWeb({
    fullHost: process.env.TRON_NODE_URL,
    privateKey,
  });
}

// =============== NATIVE TRX WITHDRAWAL WITH REFILL ===============
async function tronNativeWithdraw(to, amountRaw) {
  const amountSun = Math.floor(parseFloat(amountRaw) * 1e6); // TRX in Sun (1e6)
  const mainTronWeb = getTronWeb(adminKeys[0]);
  const mainAdmin = mainTronWeb.address.fromPrivateKey(adminKeys[0]);

  let mainBalance = await mainTronWeb.trx.getBalance(mainAdmin);
  if (mainBalance < amountSun) {
    console.log(`Main TRX balance low. Trying refill...`);
    for (let i = 1; i < adminKeys.length; i++) {
      const fallbackWeb = getTronWeb(adminKeys[i]);
      const fallbackAddr = fallbackWeb.address.fromPrivateKey(adminKeys[i]);
      const fallbackBalance = await fallbackWeb.trx.getBalance(fallbackAddr);

      if (fallbackBalance >= amountSun) {
        const refillTx = await fallbackWeb.trx.sendTransaction(mainAdmin, amountSun);
        console.log(`Refilled TRX from Admin${i + 1}: ${refillTx.txid}`);
        break;
      }
    }
    mainBalance = await mainTronWeb.trx.getBalance(mainAdmin);
    if (mainBalance < amountSun) {
      return console.error("TRX Refill failed. Insufficient balance.");
    }
  }

  const tx = await mainTronWeb.trx.sendTransaction(to, amountSun);

  await Transaction.create({
    chain: "tron",
    type: "withdrawal",
    symbol: "TRX",
    from: mainAdmin,
    to,
    amount: parseFloat(amountRaw),
    txHash: tx.txid
  });

  console.log(`TRX withdrawal complete: ${tx.txid}`);
}


// ========== BTC WITHDRAW ==========
async function btcWithdraw(symbol, to, amountRaw) {
  const NETWORK = bitcoin.networks.testnet;
  const satsPerByte = 2;
  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS_BTC || "[]");
  const amount = parseFloat(amountRaw);
  const satsToSend = Math.floor(amount * 1e8);

  const estimateFee = (inputs, outputs, satsPerByte = 2) => {
    const txSize = inputs * 68 + outputs * 31 + 10;
    return txSize * satsPerByte;
  };

  const utxoApiUrl = addr => `https://mempool.space/testnet/api/address/${addr}/utxo`;

  const getUTXOs = async (addr) => {
    const res = await axios.get(utxoApiUrl(addr));
    return res.data;
  };

  const broadcastTx = async (rawTx) => {
    const res = await axios.post("https://mempool.space/testnet/api/tx", rawTx, {
      headers: { "Content-Type": "text/plain" },
    });
    return res.data;
  };

  for (let i = 0; i < adminKeys.length; i++) {
    const keyPair = ECPair.fromWIF(adminKeys[i], NETWORK);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: NETWORK,
    });

    const utxos = await getUTXOs(address);
    let totalInput = 0;
    const psbt = new bitcoin.Psbt({ network: NETWORK });

    for (const utxo of utxos) {
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK }).output,
          value: utxo.value,
        },
      });
      totalInput += utxo.value;
    }

    const inputsCount = psbt.inputCount;
    const estimatedFee = estimateFee(inputsCount, 2, satsPerByte);
    const change = totalInput - satsToSend - estimatedFee;

    if (change < 0) {
      console.log(`❌ Admin${i + 1} has insufficient BTC.`);
      continue;
    }

    psbt.addOutput({ address: to, value: satsToSend });
    if (change > 0) {
      psbt.addOutput({ address, value: change });
    }

    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction();
    const txid = await broadcastTx(tx.toHex());

    await Transaction.create({
      chain: "bitcoin",
      type: "withdrawal",
      symbol: "BTC",
      from: address,
      to,
      amount: amount,
      txHash: txid,
    });

    console.log(`✅ BTC withdrawal successful: ${txid}`);
    return;
  }

  throw new Error("All admin BTC wallets have insufficient funds.");
}