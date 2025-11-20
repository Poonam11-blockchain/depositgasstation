
// sweeper-api.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { ethers } = require("ethers");
const TronWeb = require("tronweb");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const bitcoin = require("bitcoinjs-lib");
const axios = require("axios");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, sendAndConfirmTransaction, Transaction } = require("@solana/web3.js");
const splToken = require("@solana/spl-token");
const _bs58 = require("bs58");
const bs58 = _bs58 && _bs58.default ? _bs58.default : _bs58;

// model: Transaction logger (adjust path)
const TransactionModel = require("./src/models/transactionmodels");

// ---------- Mongo ----------
mongoose.set("strictQuery", false);
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/walletdb";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Mongo connected"))
  .catch((e) => {
    console.error("Mongo connect error:", e.message);
    process.exit(1);
  });

// ---------- Express ----------
const app = express();
app.use(bodyParser.json());

// ---------- Utilities ----------
function isProbablyPrivateKey(pk) {
  if (!pk || typeof pk !== "string") return false;
  const s = pk.startsWith("0x") ? pk.slice(2) : pk;
  return /^[0-9a-fA-F]{64}$/.test(s);
}
function maskKey(pk) {
  if (!pk) return "undefined";
  return pk.slice(0, 6) + "..." + pk.slice(-4);
}
function truthy(v) {
  if (v === true || v === "true") return true;
  if (typeof v === "string") return ["true","1","yes"].includes(v.toLowerCase());
  return Boolean(v);
}

// ---------- Job runner helper ----------
async function runChainSweep(chainName, options = {}) {
  const force = !!options.force;
  switch (chainName) {
    case "ethereum":
    case "bsc":  
      return await evmSweep(chainName, force);
    case "polygon":
      return await polygonSweep(force)
    case "tron":
      return await tronSweep(force);
    case "btc":
      return await btcSweep(force);
    case "solana":
      return await solanaSweep(force);
    default:
      throw new Error("unsupported chain");
  }
}

// ========================= EVM (ETH / BSC/polygon) =========================
async function evmSweep(chainName, isForce = false) {
  const erc20Abi = require("./erc20.json");
  const usersPath = chainName === "ethereum" ? "./eth_wallets.json" : "./bsc_wallets.json" ;
  const users = require(path.resolve(usersPath));
  const tokensPath = chainName === "ethereum" ? "./tokenethereum.json" : "./tokenbsc.json";
  const tokens = require(path.resolve(tokensPath));

  const provider = new ethers.providers.JsonRpcProvider(
    chainName === "ethereum" ? process.env.ETH_NODE_URL : process.env.BSC_NODE_URL
  );

  const destination = process.env.ADMIN_WALLET;
  if (!destination) throw new Error("Missing ADMIN_WALLET in env");

  const GAS_PK = process.env.GAS_STATION_PRIVATE_KEY;
  if (!GAS_PK || !isProbablyPrivateKey(GAS_PK)) {
    throw new Error("GAS_STATION_PRIVATE_KEY missing or invalid");
  }
  const gasStation = new ethers.Wallet(GAS_PK, provider);
  const gasStationAddr = await gasStation.getAddress();
  console.log(`⛽ Using gas station: ${gasStationAddr}`);

  const addBuffer20 = (bn) => bn.mul(12).div(10);

  // ERC-20 sweep
  for (const tokenInfo of tokens) {
    const token = new ethers.Contract(tokenInfo.address, erc20Abi, provider);
    const userThreshold = ethers.utils.parseUnits("50", tokenInfo.decimals);
    const exchangeThreshold = ethers.utils.parseUnits("100", tokenInfo.decimals);

    let eligibleUsers = [];
    let totalEligible = ethers.BigNumber.from(0);

    for (const user of users) {
      if (!user || !user.address) continue;
      if (!user.privateKey || !isProbablyPrivateKey(user.privateKey)) continue;
      try {
        const bal = await token.balanceOf(user.address);
        if (bal.gte(userThreshold)) {
          eligibleUsers.push({ ...user, balance: bal });
          totalEligible = totalEligible.add(bal);
        }
      } catch (e) {
        console.error(`Error reading ${tokenInfo.symbol} for ${user.address}: ${e.message}`);
      }
    }

    console.log(`[${chainName}] Eligible ${tokenInfo.symbol}: ${ethers.utils.formatUnits(totalEligible, tokenInfo.decimals)}`);
    if (totalEligible.lt(exchangeThreshold) && !isForce) {
      console.log(`Skipping ${tokenInfo.symbol}: threshold not met`);
      continue;
    }

    for (const user of eligibleUsers) {
      let userWallet;
      try {
        userWallet = new ethers.Wallet(user.privateKey, provider);
      } catch (e) {
        console.error(`Invalid privateKey for ${user.address}: ${e.message}`);
        continue;
      }

      try {
        const gasPrice = await provider.getGasPrice();
        let gasLimit;
        try {
          gasLimit = await token.connect(userWallet).estimateGas.transfer(destination, user.balance, { from: user.address });
        } catch {
          gasLimit = ethers.BigNumber.from(90000);
        }
        const feeNeeded = addBuffer20(gasLimit.mul(gasPrice));
        const userNativeBal = await provider.getBalance(user.address);
        if (userNativeBal.lt(feeNeeded)) {
          const topUp = feeNeeded.sub(userNativeBal);
          const fundTx = await gasStation.sendTransaction({ to: user.address, value: topUp });
          console.log(`Funded ${user.address} with ${ethers.utils.formatEther(topUp)} (tx: ${fundTx.hash})`);
          await fundTx.wait();
        }
        const tx = await token.connect(userWallet).transfer(destination, user.balance, { gasPrice, gasLimit: addBuffer20(gasLimit) });
        console.log(`Swept ${tokenInfo.symbol} from ${user.address}: ${tx.hash}`);
        await tx.wait();
        await TransactionModel.create({
          type: "sweep",
          chain: chainName,
          symbol: tokenInfo.symbol,
          from: user.address,
          to: destination,
          amount: user.balance.toString(),
          txHash: tx.hash,
          timestamp: new Date(),
        });
      } catch (err) {
        console.error(`Failed ${tokenInfo.symbol} from ${user.address}: ${err.message}`);
      }
    }
  }

  // Native sweep
  let nativeTotal = ethers.BigNumber.from(0);
  const nativeUsers = [];
  for (const user of users) {
    if (!user || !user.address || !user.privateKey || !isProbablyPrivateKey(user.privateKey)) continue;
    try {
      const bal = await provider.getBalance(user.address);
      const gasLimit = ethers.BigNumber.from(21000);
      const gasPrice = await provider.getGasPrice();
      const txCost = gasLimit.mul(gasPrice);
      if (bal.gt(txCost)) {
        const sweepable = bal.sub(txCost);
        nativeUsers.push({ ...user, sweepable, gasPrice });
        nativeTotal = nativeTotal.add(sweepable);
      }
    } catch (e) {
      console.error(`Error fetching balance for ${user.address}: ${e.message}`);
    }
  }

  for (const user of nativeUsers) {
    try {
      const wallet = new ethers.Wallet(user.privateKey, provider);
      const tx = await wallet.sendTransaction({
        to: destination,
        value: user.sweepable,
        gasLimit: 21000,
        gasPrice: user.gasPrice,
      });
      console.log(`Swept native ${chainName} from ${user.address} => ${tx.hash}`);
      await tx.wait();
      await TransactionModel.create({
        type: "sweep",
        chain: chainName,
        symbol: chainName.toUpperCase(),
        from: user.address,
        to: destination,
        amount: ethers.utils.formatEther(user.sweepable),
        txHash: tx.hash,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error(`Native sweep failed for ${user.address}: ${err.message}`);
    }
  }

  // Admin forwarding (example)
  try {
    const ADMIN_PK = process.env.ADMIN_WALLET_PRIVATE_KEY;
    if (ADMIN_PK && isProbablyPrivateKey(ADMIN_PK)) {
      const adminWallet = new ethers.Wallet(ADMIN_PK, provider);
      const nextMaster = process.env.NEXT_MASTER_WALLET;
      if (nextMaster) {
        for (const tokenInfo of tokens) {
          try {
            const token = new ethers.Contract(tokenInfo.address, erc20Abi, provider);
            const bal = await token.balanceOf(destination);
            const threshold = ethers.utils.parseUnits("2000", tokenInfo.decimals);
            if (bal.gte(threshold)) {
              const tx = await token.connect(adminWallet).transfer(nextMaster, bal);
              console.log(`Forwarded ${tokenInfo.symbol} → NEXT_MASTER: ${tx.hash}`);
              await tx.wait();
            }
          } catch (e) {
            console.error(`Forward failed for ${tokenInfo.symbol}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.warn("Admin forward error:", e.message);
  }

  return { ok: true, chain: chainName };
}

// ----------------- polygonSweep function -----------------
async function polygonSweep(isForce = false) {
  const erc20Abi = require("./erc20.json");
  const usersPath = "./eth_wallets.json";
  const tokensPath = "./tokenpolygon.json";

  const MIN_PRIORITY_GWEI = Number(process.env.POLYGON_MIN_PRIORITY_GWEI || 25);
  const GAS_CUSHION_MATIC = process.env.POLYGON_GAS_CUSHION_MATIC || "0.00002";
  const TOPUP_WAIT_MS = Number(process.env.POLYGON_TOPUP_WAIT_MS || 1200);

  const rpcEnv = process.env.POLYGON_NODE_URL;
  if (!rpcEnv) throw new Error("Missing POLYGON_NODE_URL");
  const provider = new ethers.providers.JsonRpcProvider(rpcEnv);

  const destination = process.env.ADMIN_WALLET_POLYGON || process.env.ADMIN_WALLET || process.env.ADMIN_WALLET_ETH;
  if (!destination) throw new Error("Missing ADMIN_WALLET_POLYGON / ADMIN_WALLET");

  const GAS_PK = process.env.POLYGON_GAS_STATION_PRIVATE_KEY || process.env.GAS_STATION_PRIVATE_KEY;
  if (!GAS_PK || !isProbablyPrivateKey(GAS_PK)) throw new Error("POLYGON gas station PK missing/invalid");
  const gasStation = new ethers.Wallet(GAS_PK, provider);
  const gasStationAddr = await gasStation.getAddress();
  console.log(`⛽ Using gas station for polygon: ${gasStationAddr}`);

  let users = [];
  let tokens = [];
  try { users = require(path.resolve(usersPath)); } catch (e) { console.warn(`Could not load ${usersPath}: ${e.message}`); }
  try { tokens = require(path.resolve(tokensPath)); } catch (e) { console.warn(`Could not load ${tokensPath}: ${e.message}`); }

  const parseGwei = (g) => ethers.BigNumber.from(ethers.utils.parseUnits(String(g), "gwei"));
  const parseEther = (e) => ethers.BigNumber.from(ethers.utils.parseUnits(String(e), "ether"));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // compute EIP-1559 fee params (returns BN)
  async function computeFees(priorityGwei) {
    const block = await provider.getBlock("latest");
    const baseFeePerGas = block && block.baseFeePerGas ? ethers.BigNumber.from(block.baseFeePerGas) : parseGwei(1);
    const priority = parseGwei(priorityGwei);
    const maxFee = baseFeePerGas.mul(2).add(priority); // safe buffer
    return { baseFeePerGas, maxPriorityFeePerGas: priority, maxFeePerGas: maxFee };
  }

  // TOP-UP helper: send top-up using explicit EIP-1559 fields (important!)
  async function ensureFundedForFee(userAddr, feeNeededBN, eipFees) {
    const userBalNow = await provider.getBalance(userAddr);
    if (userBalNow.gte(feeNeededBN)) return { funded: false };

    const cushion = parseEther(GAS_CUSHION_MATIC);
    const topUpAmount = feeNeededBN.add(cushion);

    // ensure gasStation has funds
    const gsBal = await provider.getBalance(gasStationAddr);
    if (gsBal.lt(topUpAmount)) {
      throw new Error(`Gas station low balance: need ${ethers.utils.formatEther(topUpAmount)} MATIC`);
    }

    // *** send top-up with explicit EIP-1559 fee fields and gasLimit=21000 ***
    const gasLimit = 21000;
    const txRequest = {
      to: userAddr,
      value: topUpAmount,
      gasLimit,
      maxPriorityFeePerGas: eipFees.maxPriorityFeePerGas,
      maxFeePerGas: eipFees.maxFeePerGas
    };

    try {
      const fundTx = await gasStation.sendTransaction(txRequest);
      console.log(`⛽ Gas-station topup tx (eip1559) sent: ${fundTx.hash} -> ${userAddr} amount=${ethers.utils.formatEther(topUpAmount)}`);
      await fundTx.wait();
      await wait(TOPUP_WAIT_MS);
      return { funded: true, txHash: fundTx.hash, amount: topUpAmount };
    } catch (e) {
      // bubble up with full message
      throw e;
    }
  }

  // token sweep
  for (const tokenInfo of tokens) {
    if (!tokenInfo || !tokenInfo.address) continue;
    const token = new ethers.Contract(tokenInfo.address, erc20Abi, provider);
    const userThreshold = ethers.utils.parseUnits(tokenInfo.userThreshold || "50", tokenInfo.decimals || 18);
    const exchangeThreshold = ethers.utils.parseUnits(tokenInfo.exchangeThreshold || "100", tokenInfo.decimals || 18);

    let eligibleUsers = [];
    let totalEligible = ethers.BigNumber.from(0);

    for (const user of users) {
      if (!user || !user.address) continue;
      if (!user.privateKey || !isProbablyPrivateKey(user.privateKey)) continue;
      try {
        const bal = await token.balanceOf(user.address);
        if (bal.gte(userThreshold)) {
          eligibleUsers.push({ ...user, balance: bal });
          totalEligible = totalEligible.add(bal);
        }
      } catch (e) {
        console.error(`Error reading ${tokenInfo.symbol || tokenInfo.address} for ${user.address}: ${e.message}`);
      }
    }

    console.log(`[polygon] Eligible ${tokenInfo.symbol || tokenInfo.address}: ${ethers.utils.formatUnits(totalEligible, tokenInfo.decimals || 18)}`);
    if (totalEligible.lt(exchangeThreshold) && !isForce) {
      console.log(`Skipping ${tokenInfo.symbol || tokenInfo.address}: threshold not met`);
      continue;
    }

    for (const user of eligibleUsers) {
      let userWallet;
      try { userWallet = new ethers.Wallet(user.privateKey, provider); } catch (e) { console.error(`Invalid privateKey ${user.address}: ${e.message}`); continue; }

      try {
        let gasLimit;
        try {
          gasLimit = await token.connect(userWallet).estimateGas.transfer(destination, user.balance, { from: user.address });
        } catch { gasLimit = ethers.BigNumber.from(90000); }

        // compute EIP-1559 fees (use enforced MIN_PRIORITY_GWEI)
        const eipFees = await computeFees(MIN_PRIORITY_GWEI);
        console.log(`[polygon][fee] user=${user.address} gasLimit=${gasLimit.toString()} priority=${ethers.utils.formatUnits(eipFees.maxPriorityFeePerGas,"gwei")} gwei maxFee=${ethers.utils.formatUnits(eipFees.maxFeePerGas,"gwei")} gwei baseFee=${ethers.utils.formatUnits(eipFees.baseFeePerGas,"gwei")} gwei`);

        const feeNeeded = gasLimit.mul(eipFees.maxFeePerGas);

        // ensure user funded (this topup will now use EIP-1559 fees)
        try {
          await ensureFundedForFee(user.address, feeNeeded, eipFees);
        } catch (topErr) {
          console.error(`Failed to top-up user ${user.address}: ${topErr && topErr.message ? topErr.message : topErr}`);
          throw topErr;
        }
        // perform token transfer using EIP-1559 fields
        const tx = await token.connect(userWallet).transfer(destination, user.balance, {
          gasLimit,
          maxPriorityFeePerGas: eipFees.maxPriorityFeePerGas,
          maxFeePerGas: eipFees.maxFeePerGas
        });
        console.log(`Swept ${tokenInfo.symbol || tokenInfo.address} from ${user.address}: ${tx.hash}`);
        await tx.wait();

        await TransactionModel.create({
          type: "sweep",
          chain: "polygon",
          symbol: tokenInfo.symbol || tokenInfo.address,
          from: user.address,
          to: destination,
          amount: user.balance.toString(),
          txHash: tx.hash,
          timestamp: new Date(),
        });
      } catch (err) {
        console.error(`Failed ${tokenInfo.symbol || tokenInfo.address} from ${user.address}:`, err && err.message ? err.message : err);
      }
    }
  }

  // native MATIC sweep (EIP-1559)
  const nativeCandidates = [];
  for (const user of users) {
    if (!user || !user.address || !user.privateKey || !isProbablyPrivateKey(user.privateKey)) continue;
    try {
      const bal = await provider.getBalance(user.address);
      const gasLimit = ethers.BigNumber.from(21000);
      const eipFees = await computeFees(MIN_PRIORITY_GWEI);
      const txCost = gasLimit.mul(eipFees.maxFeePerGas);
      if (bal.gt(txCost)) {
        const sweepable = bal.sub(txCost);
        nativeCandidates.push({ ...user, sweepable, gasLimit, eipFees });
      }
    } catch (e) {
      console.error(`Error checking MATIC for ${user.address}: ${e.message}`);
    }
  }

  for (const u of nativeCandidates) {
    try {
      const wallet = new ethers.Wallet(u.privateKey, provider);
      await ensureFundedForFee(u.address, u.gasLimit.mul(u.eipFees.maxFeePerGas), u.eipFees);

      const tx = await wallet.sendTransaction({
        to: destination,
        value: u.sweepable,
        gasLimit: u.gasLimit,
        maxPriorityFeePerGas: u.eipFees.maxPriorityFeePerGas,
        maxFeePerGas: u.eipFees.maxFeePerGas
      });
      await tx.wait();
      console.log(`Swept native polygon (MATIC) from ${u.address} => ${tx.hash}`);
      await TransactionModel.create({
        type: "sweep",
        chain: "polygon",
        symbol: "MATIC",
        from: u.address,
        to: destination,
        amount: ethers.utils.formatEther(u.sweepable),
        txHash: tx.hash,
        timestamp: new Date(),
      });
    } catch (e) {
      console.error(`Native polygon sweep failed for ${u.address}:`, e && e.message ? e.message : e);
    }
  }

  return { ok: true, chain: "polygon" };
}

// ============================ TRON ============================
async function tronSweep(isForce = false) {
  const trc20Abi = require("./trc20.json");
  const users = require("./tron_wallets.json");
  const tokens = require("./tokentron.json");
  const fullHost = process.env.TRON_NODE_URL;
  if (!fullHost) throw new Error("Missing TRON_NODE_URL");

  const destination = process.env.ADMIN_WALLET_TRON;
  const nextMasterTron = process.env.NEXT_MASTER_WALLET_TRON;
  const adminTronPK = process.env.ADMIN_WALLET_PRIVATE_KEY_TRON;
  if (!destination || !nextMasterTron || !adminTronPK) {
    throw new Error("Missing TRON admin / next master envs");
  }

  const TRON_GAS_PK = process.env.TRON_GAS_STATION_PRIVATE_KEY || adminTronPK;
  const tronWebAdmin = new TronWeb({ fullHost, privateKey: adminTronPK });
  const gasStationTron = new TronWeb({ fullHost, privateKey: TRON_GAS_PK });

  // Config
  const MIN_TOPUP_TRX = Number(process.env.TRON_MIN_TOPUP_TRX || 5); // TRX to ensure on user for fees
  const TOPUP_BUFFER_TRX = Number(process.env.TRON_TOPUP_BUFFER_TRX || 0.5); // extra buffer
  const MIN_TOPUP_SUN = Math.round(MIN_TOPUP_TRX * 1e6);
  const TOPUP_BUFFER_SUN = Math.round(TOPUP_BUFFER_TRX * 1e6);
  const TOPUP_RETRIES = Number(process.env.TRON_TOPUP_RETRIES || 3);
  const TOPUP_CONFIRM_TIMEOUT_MS = Number(process.env.TRON_TOPUP_CONFIRM_TIMEOUT_MS || 30_000);

  // wait for tx confirmation (poll getTransactionInfo)
  async function waitForTronTx(txid, timeoutMs = TOPUP_CONFIRM_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const info = await tronWebAdmin.trx.getTransactionInfo(txid);
        if (info && (info.blockNumber || info.receipt || info.contractRet)) return info;
      } catch (e) {
        // ignore transient
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }

  // topUp user address from gas-station: send only needed + buffer; retry
  async function topUpUserIfNeeded(userAddr, requiredSun) {
    try {
      const current = await gasStationTron.trx.getBalance(userAddr);
      const deficit = Math.max(0, requiredSun - current);
      if (deficit === 0) return { funded: false }; // nothing to do

      const sendAmount = deficit + TOPUP_BUFFER_SUN;
      let lastErr;
      for (let attempt = 1; attempt <= TOPUP_RETRIES; attempt++) {
        try {
          const resp = await gasStationTron.trx.sendTransaction(userAddr, sendAmount);
          const txid = resp && (resp.txid || resp);
          if (!txid) throw new Error("no_txid_from_gasstation");
          const confirmed = await waitForTronTx(txid);
          if (!confirmed) {
            console.warn(`⚠️ gasStation topup tx ${txid} not confirmed within timeout`);
            // still return as attempted (so caller can decide)
            return { funded: true, txid };
          }
          return { funded: true, txid };
        } catch (e) {
          lastErr = e;
          console.warn(`⚠️ gasStation topup attempt ${attempt} failed: ${e.message || e}`);
          await new Promise((r) => setTimeout(r, 1000 * attempt)); // backoff
        }
      }
      throw lastErr || new Error("topup_failed");
    } catch (e) {
      throw e;
    }
  }

  // ---------- NATIVE TRX SWEEP ----------
  // Do NOT top-up here. Only sweep accounts that already have sweepable balance.
  try {
    const nativeCandidates = [];
    for (const user of users) {
      if (!user.privateKey) continue;
      try {
        const tronWebUser = new TronWeb({ fullHost, privateKey: user.privateKey });
        const bal = await tronWebUser.trx.getBalance(user.address); // in SUN
        const reserve = MIN_TOPUP_SUN; // reserve to keep on user
        const sweepable = Math.max(0, bal - reserve);
        if (sweepable > 0) {
          nativeCandidates.push({ user, sweepable, tronWebUser });
        } else {
          // skip — we will not top up for native sweep if sweepable==0
          // (this prevents funding accounts with no sweepable native)
        }
      } catch (e) {
        console.warn(`Error checking TRX for ${user.address}: ${e.message || e}`);
      }
    }

    for (const item of nativeCandidates) {
      try {
        const tx = await item.tronWebUser.trx.sendTransaction(destination, item.sweepable);
        const txid = tx && (tx.txid || tx);
        console.log(`✅ Swept TRX from ${item.user.address} => TxID: ${txid} amount=${(item.sweepable/1e6).toFixed(6)} TRX`);
        try {
          await TransactionModel.create({
            type: "sweep",
            chain: "tron",
            symbol: "TRX",
            from: item.user.address,
            to: destination,
            amount: (item.sweepable / 1e6).toFixed(6),
            txHash: txid,
            timestamp: new Date(),
          });
        } catch (e) {
          console.warn("⚠️ DB save failed for TRX sweep:", e.message || e);
        }
      } catch (err) {
        console.error(`❌ Native sweep failed for ${item.user.address}: ${err.message || err}`);
      }
    }
  } catch (err) {
    console.error("❌ Error in native TRX sweep phase:", err?.message || err);
  }

  // ---------- TRC20 SWEEP ----------
  // For each token, compute eligible users first, then top-up ONLY those eligible users if needed, then transfer.
  for (const token of tokens) {
    try {
      const userThreshold = BigInt(50) * 10n ** BigInt(token.decimals);
      const exchangeThreshold = BigInt(100) * 10n ** BigInt(token.decimals);

      let totalEligible = 0n;
      const eligible = [];

      // Identify eligible users (by token balance)
      for (const user of users) {
        try {
          if (!user.privateKey) continue;
          const tronWebUser = new TronWeb({ fullHost, privateKey: user.privateKey });
          const tokenContract = await tronWebUser.contract(trc20Abi, token.address);
          const balRaw = await tokenContract.methods.balanceOf(user.address).call();
          const bal = BigInt(balRaw.toString());
          if (bal >= userThreshold) {
            totalEligible += bal;
            eligible.push({ user, bal });
          }
        } catch (e) {
          console.error(`❌ Error checking ${token.symbol} for ${user.address}: ${e.message || e}`);
        }
      }

      if (totalEligible < exchangeThreshold && !isForce) {
        console.log(`⛔ Skipping ${token.symbol}: threshold not met`);
        continue;
      }

      // For each eligible user: ensure they have TRX to pay fee (top-up only if necessary), then transfer token
      for (const { user, bal } of eligible) {
        try {
          const tronWebUser = new TronWeb({ fullHost, privateKey: user.privateKey });
          const tokenContract = await tronWebUser.contract(trc20Abi, token.address);

          const currSun = await tronWebUser.trx.getBalance(user.address);

          // Conservative requirement: ensure user has MIN_TOPUP_SUN to cover fees
          if (currSun < MIN_TOPUP_SUN) {
            console.log(`⛽ TRC20: need topup for ${user.address} before ${token.symbol} transfer (balance ${(currSun/1e6).toFixed(6)} TRX)`);
            try {
              const topRes = await topUpUserIfNeeded(user.address, MIN_TOPUP_SUN);
              if (topRes.funded) {
                console.log(`⛽ Gas station funded ${user.address} for TRC20 transfer (tx ${topRes.txid})`);
              } else {
                console.warn(`⚠️ Gas station did not fund ${user.address} for ${token.symbol}. Skipping user.`);
                continue;
              }
            } catch (e) {
              console.error(`❌ Failed top-up before TRC20 transfer for ${user.address}: ${e.message || e}`);
              continue;
            }
          }

          // perform TRC20 transfer; feeLimit tuned (50_000_000 is used in your code)
          const transferResp = await tokenContract.methods.transfer(destination, bal.toString()).send({ feeLimit: 50_000_000 });
          const txid = transferResp && (transferResp.txid || transferResp.transactionId || transferResp);
          console.log(`✅ TRC20 ${token.symbol} from ${user.address} => TxID: ${txid} amount=${bal.toString()}`);
          try {
            await TransactionModel.create({
              type: "sweep",
              chain: "tron",
              symbol: token.symbol,
              from: user.address,
              to: destination,
              amount: bal.toString(),
              txHash: txid,
              timestamp: new Date(),
            });
          } catch (e) {
            console.warn("⚠️ DB save failed for TRC20 sweep:", e.message || e);
          }
        } catch (err) {
          console.error(`❌ Failed ${token.symbol} from ${user.address}: ${err.message || err}`);
        }
      }
    } catch (err) {
      console.error(`❌ Token loop error for ${token.symbol}: ${err.message || err}`);
    }
  }

  // Optionally forward admin TRC20 to next master (omitted for brevity)

  return { ok: true, chain: "tron" };
}

// ============================ BTC ============================
async function btcSweep(isForce = false) {
  const { ECPairFactory } = require("ecpair");
  const tinysecp = require("tiny-secp256k1");
  const ECPair = ECPairFactory(tinysecp);

  const NETWORK = process.env.BTC_MAINNET === "1" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const DESTINATION_ADDRESS = process.env.ADMIN_WALLET_BTC;
  if (!DESTINATION_ADDRESS) throw new Error("Missing ADMIN_WALLET_BTC");

  const wallets = require("./btc_wallets.json");

  async function fetchUTXOs(address) {
    const url = NETWORK === bitcoin.networks.bitcoin
      ? `https://mempool.space/api/address/${address}/utxo`
      : `https://mempool.space/testnet/api/address/${address}/utxo`;
    const res = await axios.get(url);
    return res.data;
  }
  async function broadcastTx(rawTx) {
    const url = NETWORK === bitcoin.networks.bitcoin
      ? "https://mempool.space/api/tx"
      : "https://mempool.space/testnet/api/tx";
    const res = await axios.post(url, rawTx, { headers: { "Content-Type":"text/plain" } });
    return res.data;
  }

  for (const wallet of wallets) {
    try {
      if (!wallet.privateKey) continue;
      const keyPair = ECPair.fromWIF(wallet.privateKey, NETWORK);
      const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK });
      const utxos = await fetchUTXOs(address);
      if (!utxos || utxos.length === 0) continue;

      const psbt = new bitcoin.Psbt({ network: NETWORK });
      let totalInput = 0;
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
      const fee = parseInt(process.env.BTC_STATIC_FEE || "178", 10);
      if (totalInput <= fee) continue;
      psbt.addOutput({ address: DESTINATION_ADDRESS, value: totalInput - fee });
      psbt.signAllInputs(keyPair);
      psbt.validateSignaturesOfAllInputs(() => true);
      psbt.finalizeAllInputs();
      const tx = psbt.extractTransaction();
      const txHex = tx.toHex();
      const txid = await broadcastTx(txHex);
      console.log(`Swept ${address} → ${DESTINATION_ADDRESS}: ${txid}`);
      await TransactionModel.create({
        type: "sweep",
        chain: "btc",
        symbol: "BTC",
        from: address,
        to: DESTINATION_ADDRESS,
        amount: (totalInput - fee) / 1e8,
        txHash: txid,
        timestamp: new Date(),
      });
    } catch (e) {
      console.error("Error sweeping BTC wallet:", e.message || e);
    }
  }
  return { ok: true, chain: "btc" };
}

// ------------------------ SOLANA ------------------------
function loadSolKey(key) {
  if (!key) return null;
  if (Array.isArray(key)) return Keypair.fromSecretKey(Uint8Array.from(key));
  try {
    const maybe = JSON.parse(key);
    if (Array.isArray(maybe)) return Keypair.fromSecretKey(Uint8Array.from(maybe));
  } catch (e) {}
  try {
    const raw = bs58.decode(key);
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch (e) {
    throw new Error("Invalid Solana private key format");
  }
}

async function solanaSweep(isForce = false) {
  const users = require("./user_walletsfinalmultichain.json");
  const tokens = require("./tokensolana.json");
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) throw new Error("Missing SOLANA_RPC_URL");
  const connection = new Connection(rpc, "confirmed");
  const destination = process.env.ADMIN_WALLET_SOL;
  if (!destination) throw new Error("Missing ADMIN_WALLET_SOL");

  const GAS_KEY_RAW = process.env.SOL_GAS_STATION_PRIVATE_KEY || process.env.ADMIN_WALLET_PRIVATE_KEY_SOL;
  if (!GAS_KEY_RAW) throw new Error("Missing SOL gas/admin keys");
  const gasKeypair = loadSolKey(GAS_KEY_RAW);

  // SPL token sweep & native SOL sweep (simplified from original)
  // SPL sweep
  for (const token of tokens) {
    if (!token || !token.address || token.address.trim().length === 0) continue;
    const mintPub = new PublicKey(token.address);
    const tokenDecimals = token.decimals ?? 9;

    let totalEligible = 0n;
    const eligible = [];
    for (const user of users) {
      if (!user || !user.address || !user.privateKey) continue;
      try {
        const owner = new PublicKey(user.address);
        const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPub });
        let balanceRaw = 0n;
        for (const acc of resp.value) {
          const amt = acc.account.data.parsed.info.tokenAmount;
          if (amt && amt.amount) balanceRaw += BigInt(amt.amount);
        }
        const userThreshold = BigInt(50) * 10n ** BigInt(tokenDecimals);
        if (balanceRaw >= userThreshold) {
          totalEligible += balanceRaw;
          eligible.push({ user, balance: balanceRaw });
        }
      } catch (e) {
        console.error(`Error checking SPL for ${user.address}: ${e.message}`);
      }
    }

    const exchangeThreshold = BigInt(100) * 10n ** BigInt(tokenDecimals);
    if (totalEligible < exchangeThreshold && !isForce) {
      console.log(`Skipping ${token.symbol || token.address}: threshold not met`);
      continue;
    }

    for (const { user, balance } of eligible) {
      try {
        const userKp = loadSolKey(user.privateKey);
        const userPub = userKp.publicKey;
        const destPub = new PublicKey(destination);
        const mint = mintPub;
        const destATA = await splToken.getAssociatedTokenAddress(mint, destPub);
        const userATA = await splToken.getAssociatedTokenAddress(mint, userPub);

        const instructions = [];
        const destATAInfo = await connection.getAccountInfo(destATA);
        if (!destATAInfo) {
          instructions.push(splToken.createAssociatedTokenAccountInstruction(gasKeypair.publicKey, destATA, destPub, mint));
        }
        instructions.push(splToken.createTransferInstruction(userATA, destATA, userPub, BigInt(balance), []));
        const tx = new Transaction().add(...instructions);
        const signers = [userKp];
        if (!destATAInfo) signers.push(gasKeypair);
        const sig = await sendAndConfirmTransaction(connection, tx, signers);
        console.log(`SPL ${token.symbol} swept from ${user.address}: ${sig}`);
        await TransactionModel.create({
          type: "sweep",
          chain: "solana",
          symbol: token.symbol,
          from: user.address,
          to: destination,
          amount: balance.toString(),
          txHash: sig,
          timestamp: new Date(),
        });
      } catch (e) {
        console.error(`Failed SPL sweep for ${user.address}: ${e.message}`);
      }
    }
  }

  // Native SOL sweep
  let nativeTotal = 0n;
  const nativeUsers = [];
  for (const user of users) {
    if (!user || !user.address || !user.privateKey) continue;
    try {
      const kp = loadSolKey(user.privateKey);
      const lam = BigInt(await connection.getBalance(kp.publicKey));
      const feeBuffer = BigInt(Math.ceil(0.001 * LAMPORTS_PER_SOL));
      if (lam > feeBuffer) {
        const sweepable = lam - feeBuffer;
        nativeUsers.push({ user, sweepable, kp });
        nativeTotal += sweepable;
      }
    } catch (e) {
      console.error(`Error getting SOL balance for ${user.address}: ${e.message}`);
    }
  }

  for (const { user, sweepable, kp } of nativeUsers) {
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(destination), lamports: Number(sweepable) })
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      console.log(`Swept native SOL from ${kp.publicKey.toBase58()} => ${sig}`);
      await TransactionModel.create({
        type: "sweep",
        chain: "solana",
        symbol: "SOL",
        from: kp.publicKey.toBase58(),
        to: destination,
        amount: (Number(sweepable) / Number(LAMPORTS_PER_SOL)).toString(),
        txHash: sig,
        timestamp: new Date(),
      });
    } catch (e) {
      console.error(`Native SOL sweep failed: ${e.message}`);
    }
  }

  return { ok: true, chain: "solana" };
}

// ---------- API endpoint ----------
app.post("/api/sweep", async (req, res) => {
  try {
    const body = req.body || {};
    const chain = (body.chain || "").toLowerCase();
    const force = truthy(body.force);
    if (!chain || !["ethereum","bsc","tron","btc","solana","polygon"].includes(chain)) {
      return res.status(400).json({ error: "chain required: ethereum|bsc|tron|btc|solana|polygon" });
    }

    console.log(`Received sweep request: chain=${chain} force=${force}`);
    // run sweep (await completion)
    const result = await runChainSweep(chain, { force });
    return res.json({ ok: true, result });
  } catch (err) {
    console.error("Sweep API error:", err.stack || err.message);
    return res.status(500).json({ error: err.message || "internal" });
  }
});


// health
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.SWEEPER_PORT || 4000;
app.listen(PORT, () => console.log(`Sweeper API listening on ${PORT}`));

