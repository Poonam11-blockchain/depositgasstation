
//withdrawalHandler.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { ethers } = require("ethers");
const TronWeb = require("tronweb");
const mongoose = require("mongoose");
const bitcoin = require("bitcoinjs-lib");
const axios = require("axios");
const { ECPairFactory } = require("ecpair");
const tinysecp = require("tiny-secp256k1");

const Transaction = require("./src/models/transactionmodels");
const Withdrawal = require("./src/models/withdrawalmodels");
const UserBalance = require("./src/models/userBalancemodels");

const ERC20_ABI = require("./erc20.json");
const TRC20_ABI = require("./trc20.json");

const ECPair = ECPairFactory(tinysecp);

const app = express();
app.use(bodyParser.json());

// Connect once
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("Mongo connection error:", err);
    process.exit(1);
  });

  // --- safe env JSON loader for private key arrays ---
function loadJsonArrayEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`${name} must be a non-empty JSON array`);
    }
    return parsed;
  } catch (err) {
    // avoid printing secrets; include only minimal info
    throw new Error(`Failed to parse ${name} as JSON array: ${err.message}`);
  }
}

// Utility: normalize address by chain
function normalizeTo(chain, to) {
  if (!to) return to;
  return chain === "tron" ? to : to.toLowerCase();
}

/**
 * POST /withdrawals
 * Body: { chain: "ethereum"|"bsc"|"tron"|"bitcoin", symbol: "USDT"|..., to: "addr", amount: 1.23, autoRun: true/false (optional) }
 */

app.post("/withdrawals", async (req, res) => {
  try {
    const { chain: chainArg, symbol: symbolArg, to: toArg, amount: amountRaw, autoRun } = req.body;
    if (!chainArg || !symbolArg || !toArg || typeof amountRaw === "undefined") {
      return res.status(400).json({ error: "chain, symbol, to, amount required" });
    }

    const chain = chainArg.toLowerCase();
    const symbol = symbolArg.toUpperCase();
    const to = normalizeTo(chain, toArg);
    const amount = parseFloat(amountRaw);

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "invalid amount" });
    }

    // Lookup balance in DB
    const userBalance = await UserBalance.findOne({ address: to, chain, symbol });
    if (!userBalance || userBalance.balance < amount) {
      return res.status(400).json({ error: "insufficient balance in database" });
    }

    // Auto-approval rule (keeps same behavior as your script)
const NATIVE_THRESHOLD = 0.001;
const TOKEN_THRESHOLD = 50;
const NATIVE_SYMBOLS = new Set(['ETH','BNB','MATIC','TRX','BTC']);

const isNative = NATIVE_SYMBOLS.has(symbol);
const isAutoApproved = isNative ? (amount < NATIVE_THRESHOLD) : (amount < TOKEN_THRESHOLD);

    const withdrawal = await Withdrawal.create({
      chain,
      symbol,
      to,
      amount,
      status: "pending",
      isApproved: isAutoApproved,
    });
  
    // If not auto-approved just return the created withdrawal (for multisig review)
    if (!isAutoApproved || autoRun === false) {
      return res.status(201).json({ message: "withdrawal created (awaiting approval)", withdrawal });
    }

    // Attempt to perform withdrawal immediately (same flows as your script)
    try {
      if (chain === "tron") {
        if (symbol === "TRX") {
          await tronNativeWithdraw(to, amount);
        } else {
          await tronWithdraw(symbol, to, amount);
        }
      } else if (chain === "bitcoin" || chain === "btc") {
        await btcWithdraw(symbol, to, amount);
      } else {
        // EVM-like chains: ethereum, bsc, polygon
        if (chain === "polygon") {
          // polygon has its own helpers which handle gas-topups/refills
          if (symbol === "MATIC") {
            await polygonNativeWithdraw(to, amount);
          } else {
            await polygonWithdraw(symbol, to, amount);
          }
        } else { 
          // existing behavior for ethereum/bsc
          if (symbol === "ETH" || symbol === "BNB") {
            await evmNativeWithdraw(chain, symbol, to, amount);
          } else {
            await evmWithdraw(chain, symbol, to, amount);
          }
        }
      }

      // mark completed + decrement user balance
      await Withdrawal.findByIdAndUpdate(withdrawal._id, { status: "completed", isApproved: true });
      await UserBalance.findOneAndUpdate(
        { address: to, chain, symbol },
        { $inc: { balance: -amount } }
      );

      return res.status(200).json({ message: "withdrawal completed", withdrawalId: withdrawal._id });
    } catch (innerErr) {
      console.error("Withdrawal execution error:", innerErr);
      // mark failed
      await Withdrawal.findByIdAndUpdate(withdrawal._id, { status: "failed" });
      return res.status(500).json({ error: "withdrawal execution failed", details: innerErr.message || innerErr });
    }
  } catch (err) {
    console.error("API error:", err);
    return res.status(500).json({ error: "internal server error", details: err.message || err });
  }
});

app.get("/withdrawals/:id", async (req, res) => {
  const w = await Withdrawal.findById(req.params.id);
  if (!w) return res.status(404).json({ error: "not found" });
  return res.json(w);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Withdrawal API listening on ${PORT}`));

/* ------------------------------
   Below: withdrawal implementation code (copied/adapted from your script)
   You can move these into a separate module to avoid duplication.
   ------------------------------ */

// ========== EVM TOKEN WITHDRAW ==========
async function evmWithdraw(chain, symbol, to, amountRaw) {
  const tokens = require(`./token${chain}.json`);
  const tokenInfo = tokens.find(t => t.symbol === symbol);
  if (!tokenInfo) {
    throw new Error(`${symbol} not configured in token${chain}.json`);
  }

  const provider = new ethers.providers.JsonRpcProvider(
    chain === "ethereum" ? process.env.ETH_NODE_URL : process.env.BSC_NODE_URL
  );

  const adminKeys = loadJsonArrayEnv("ADMIN_WALLET_PRIVATE_KEY");
  const mainAdminWallet = new ethers.Wallet(adminKeys[0], provider);
  const token = new ethers.Contract(tokenInfo.address, ERC20_ABI, mainAdminWallet);
  const amount = ethers.utils.parseUnits(amountRaw.toString(), tokenInfo.decimals);

  // Check main admin balance and attempt refill if needed
  let mainBalance = await token.balanceOf(mainAdminWallet.address);
  if (mainBalance.lt(amount)) {
    for (let i = 1; i < adminKeys.length; i++) {
      const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
      const fallbackToken = new ethers.Contract(tokenInfo.address, ERC20_ABI, fallbackWallet);
      const fallbackBalance = await fallbackToken.balanceOf(fallbackWallet.address);

      if (fallbackBalance.gte(amount)) {
        const refillTx = await fallbackToken.transfer(mainAdminWallet.address, amount);
        console.log(`🔁 Refilled from Admin${i + 1}: ${refillTx.hash}`);
        await refillTx.wait();
        mainBalance = await token.balanceOf(mainAdminWallet.address);
        break;
      }
    }

    if (mainBalance.lt(amount)) {
      throw new Error("Refill failed. Not enough funds in fallback admins.");
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
    amount: parseFloat(amountRaw),
    txHash: tx.hash
  });

  console.log(`✅ EVM withdrawal complete: ${tx.hash}`);
}

// ========== EVM NATIVE (ETH/BNB) ========== //
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
  // tokens file name follows your pattern: tokenpolygon.json
  const tokens = require("./tokenpolygon.json");
  const tokenInfo = tokens.find(t => t.symbol === symbol);
  if (!tokenInfo) throw new Error(`Token ${symbol} not configured in tokenpolygon.json`);

  // provider
  const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_NODE_URL);
  if (!process.env.POLYGON_NODE_URL) throw new Error("POLYGON_NODE_URL is required");

  // load admin keys: prefer chain-specific var, fallback to generic
   const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS);
  const mainAdminKey = adminKeys[0];
  const mainAdminWallet = new ethers.Wallet(mainAdminKey, provider);

  const token = new ethers.Contract(tokenInfo.address, ERC20_ABI, mainAdminWallet);
  const amount = ethers.utils.parseUnits(String(amountRaw), tokenInfo.decimals);

  // 1) ensure token balance on main admin (refill from fallback token wallets if needed)
  let mainTokenBal = await token.balanceOf(mainAdminWallet.address);
  if (BigInt(mainTokenBal.toString()) < BigInt(amount.toString())) {
    console.log(`⚠️ Main polygon admin token (${symbol}) low. Attempting refill from fallback admins...`);
    let refilled = false;
    for (let i = 1; i < adminKeys.length; i++) {
      try {
        const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
        const fallbackToken = new ethers.Contract(tokenInfo.address, ERC20_ABI, fallbackWallet);
        const fallbackTokenBal = await fallbackToken.balanceOf(fallbackWallet.address);

        if (BigInt(fallbackTokenBal.toString()) >= BigInt(amount.toString())) {
          // check fallback has enough native MATIC to pay gas for the token transfer
          const estGasLimit = ethers.BigNumber.from(90000);
          const gasPrice = await provider.getGasPrice();
          const feeNeeded = estGasLimit.mul(gasPrice);
          const fallbackNative = await provider.getBalance(fallbackWallet.address);

          if (fallbackNative.lt(feeNeeded)) {
            console.warn(`⚠️ Fallback admin ${fallbackWallet.address} doesn't have enough MATIC to send token. Skipping this fallback.`);
            continue;
          }

          const refillTx = await fallbackToken.transfer(mainAdminWallet.address, amount);
          console.log(`⛽ Refill token ${symbol} from Admin${i + 1}: ${refillTx.hash}`);
          await refillTx.wait();
          refilled = true;
          break;
        }
      } catch (e) {
        console.warn(`⚠️ Refill attempt from Admin${i + 1} failed: ${e.message}`);
      }
    }

    // re-check
    mainTokenBal = await token.balanceOf(mainAdminWallet.address);
    if (BigInt(mainTokenBal.toString()) < BigInt(amount.toString())) {
      throw new Error("Refill failed: no fallback admin had enough token + MATIC for gas.");
    }
    if (refilled) await new Promise(r => setTimeout(r, 800));
  }

  // 2) ensure main admin has enough MATIC to pay gas for the token transfer
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
    console.log(`⚠️ Main polygon admin MATIC low for gas. Attempting to top-up from fallbacks...`);
    let nativeRefilled = false;
    for (let i = 1; i < adminKeys.length; i++) {
      try {
        const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
        const fallbackBalance = await provider.getBalance(fallbackWallet.address);
        if (fallbackBalance.gte(feeNeeded)) {
          const tx = await fallbackWallet.sendTransaction({ to: mainAdminWallet.address, value: feeNeeded });
          console.log(`⛽ Refilled main admin MATIC from Admin${i + 1}: ${tx.hash}`);
          await tx.wait();
          nativeRefilled = true;
          break;
        }
      } catch (e) {
        console.warn(`⚠️ Native refill attempt from Admin${i + 1} failed: ${e.message}`);
      }
    }

    mainNativeBal = await provider.getBalance(mainAdminWallet.address);
    if (mainNativeBal.lt(feeNeeded)) {
      throw new Error("Refill failed: no fallback admin had sufficient MATIC for gas.");
    }
    if (nativeRefilled) await new Promise(r => setTimeout(r, 800));
  }

  // 3) Do the token transfer
  try {
    const tx = await token.transfer(to, amount, { gasLimit, gasPrice });
    console.log(`✅ Polygon token withdrawal (${symbol}) tx: ${tx.hash}`);
    await tx.wait();

    await Transaction.create({
      chain: "polygon",
      type: "withdrawal",
      symbol,
      from: mainAdminWallet.address,
      to,
      amount: parseFloat(amountRaw),
      txHash: tx.hash,
    });
  } catch (err) {
    console.error(`❌ polygonWithdraw failed: ${err && err.message ? err.message : err}`);
    throw err;
  }
}

// ---------------- POLYGON: native MATIC withdraw ----------------
async function polygonNativeWithdraw(to, amountRaw) {
  const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_NODE_URL);
  if (!process.env.POLYGON_NODE_URL) throw new Error("POLYGON_NODE_URL is required");

  // load admin keys (chain-specific or fallback)
  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS);
  const mainAdminWallet = new ethers.Wallet(adminKeys[0], provider);
  const value = ethers.utils.parseEther(String(amountRaw));

  // ensure main admin has enough native MATIC; attempt refill from fallback admins
  let mainBal = await provider.getBalance(mainAdminWallet.address);
  if (mainBal.lt(value)) {
    console.log("⚠️ Main polygon admin MATIC low. Trying fallback refill...");
    let refilled = false;
    for (let i = 1; i < adminKeys.length; i++) {
      try {
        const fallbackWallet = new ethers.Wallet(adminKeys[i], provider);
        const fallbackBal = await provider.getBalance(fallbackWallet.address);
        if (fallbackBal.gte(value)) {
          const tx = await fallbackWallet.sendTransaction({ to: mainAdminWallet.address, value });
          console.log(`⛽ Refilled MATIC from Admin${i + 1}: ${tx.hash}`);
          await tx.wait();
          refilled = true;
          break;
        }
      } catch (e) {
        console.warn(`⚠️ MATIC refill attempt from Admin${i + 1} failed: ${e.message}`);
      }
    }

    mainBal = await provider.getBalance(mainAdminWallet.address);
    if (mainBal.lt(value)) {
      throw new Error("Refill failed: no fallback admin had sufficient MATIC for the withdrawal.");
    }
    if (refilled) await new Promise(r => setTimeout(r, 800));
  }

  // send native MATIC
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
    console.error(`❌ polygonNativeWithdraw failed: ${err && err.message ? err.message : err}`);
    throw err;
  }
}



// ========== TRON HELPERS ==========
const tronAdminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS_TRON || "[]");
function getTronWeb(privateKey) {
  return new TronWeb({
    fullHost: process.env.TRON_NODE_URL,
    privateKey,
  });
}

async function tronWithdraw(symbol, to, amountRaw) {
  const tokens = require("./tokentron.json");
  const tokenInfo = tokens.find(t => t.symbol === symbol);
  if (!tokenInfo) throw new Error(`Token ${symbol} not found in tokentron.json`);

  const mainTronWeb = getTronWeb(tronAdminKeys[0]);
  const contract = await mainTronWeb.contract(TRC20_ABI, tokenInfo.address);
  const amount = BigInt(Math.floor(parseFloat(amountRaw) * (10 ** tokenInfo.decimals))).toString();

  const mainAdmin = mainTronWeb.address.fromPrivateKey(tronAdminKeys[0]);
  let mainBalance = await contract.methods.balanceOf(mainAdmin).call();

  if (BigInt(mainBalance) < BigInt(amount)) {
    for (let i = 1; i < tronAdminKeys.length; i++) {
      const fallbackWeb = getTronWeb(tronAdminKeys[i]);
      const fallbackAddr = fallbackWeb.address.fromPrivateKey(tronAdminKeys[i]);
      const fallbackContract = await fallbackWeb.contract(TRC20_ABI, tokenInfo.address);
      const fallbackBalance = await fallbackContract.methods.balanceOf(fallbackAddr).call();

      if (BigInt(fallbackBalance) >= BigInt(amount)) {
        await fallbackContract.methods.transfer(mainAdmin, amount).send({ feeLimit: 15_000_000 });
        console.log(`Refilled ${symbol} from Admin${i + 1}`);
        break;
      }
    }
    mainBalance = await contract.methods.balanceOf(mainAdmin).call();
    if (BigInt(mainBalance) < BigInt(amount)) {
      throw new Error("Insufficient funds even after refill.");
    }
  }

  const tx = await contract.methods.transfer(to, amount).send({ feeLimit: 15_000_000 });

  await Transaction.create({
    chain: "tron",
    type: "withdrawal",
    symbol,
    from: mainAdmin,
    to,
    amount: parseFloat(amountRaw),
    txHash: tx
  });

  console.log(`TRC20 ${symbol} withdrawal complete: ${tx}`);
}

async function tronNativeWithdraw(to, amountRaw) {
  const amountSun = Math.floor(parseFloat(amountRaw) * 1e6);
  const mainTronWeb = getTronWeb(tronAdminKeys[0]);
  const mainAdmin = mainTronWeb.address.fromPrivateKey(tronAdminKeys[0]);

  let mainBalance = await mainTronWeb.trx.getBalance(mainAdmin);
  if (mainBalance < amountSun) {
    for (let i = 1; i < tronAdminKeys.length; i++) {
      const fallbackWeb = getTronWeb(tronAdminKeys[i]);
      const fallbackAddr = fallbackWeb.address.fromPrivateKey(tronAdminKeys[i]);
      const fallbackBalance = await fallbackWeb.trx.getBalance(fallbackAddr);

      if (fallbackBalance >= amountSun) {
        const refillTx = await fallbackWeb.trx.sendTransaction(mainAdmin, amountSun);
        console.log(`Refilled TRX from Admin${i + 1}: ${refillTx.txid}`);
        break;
      }
    }
    mainBalance = await mainTronWeb.trx.getBalance(mainAdmin);
    if (mainBalance < amountSun) {
      throw new Error("TRX Refill failed. Insufficient balance.");
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

