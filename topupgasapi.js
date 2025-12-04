
// topupGasApi.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const TronWeb = require("tronweb");
const {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const _bs58 = require("bs58");
const bs58 = _bs58 && _bs58.default ? _bs58.default : _bs58;

const Address = require("./src/models/Wallets");

// ---------- Helpers ----------
function isProbablyPrivateKey(pk) {
  if (!pk || typeof pk !== "string") return false;
  const s = pk.startsWith("0x") ? pk.slice(2) : pk;
  return /^[0-9a-fA-F]{64}$/.test(s);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// For Solana gas key
function loadSolKey(key) {
  if (!key) throw new Error("Solana private key missing");
  // If it's a JSON array of numbers
  if (Array.isArray(key)) {
    return Keypair.fromSecretKey(Uint8Array.from(key));
  }
  try {
    const maybe = JSON.parse(key);
    if (Array.isArray(maybe)) {
      return Keypair.fromSecretKey(Uint8Array.from(maybe));
    }
  } catch (_) {
    // not JSON, ignore
  }
  // Assume base58-encoded secret key
  try {
    const raw = bs58.decode(key);
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch (e) {
    throw new Error("Invalid Solana gas-station private key format");
  }
}

// ---------- Mongo ----------
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/walletdb";

mongoose.set("strictQuery", false);
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("Mongo connected (topupGas API)"))
  .catch((e) => {
    console.error("Mongo connect error:", e.message);
    process.exit(1);
  });

// ---------- Chain configs (EVM only) ----------
const CHAIN_CONFIGS = {
  ethereum: {
    rpcEnv: "ETH_NODE_URL",
    gasPkEnv: "ETH_GAS_STATION_PRIVATE_KEY", // can fallback to GAS_STATION_PRIVATE_KEY
    minGasEnv: "ETH_MIN_GAS_ETH",
    targetGasEnv: "ETH_TARGET_GAS_ETH",
    defaultMinGas: "0.0002",
    defaultTargetGas: "0.0004",
  },
  bsc: {
    rpcEnv: "BSC_NODE_URL",
    gasPkEnv: "BSC_GAS_STATION_PRIVATE_KEY",
    minGasEnv: "BSC_MIN_GAS_BNB",
    targetGasEnv: "BSC_TARGET_GAS_BNB",
    defaultMinGas: "0.0005",
    defaultTargetGas: "0.001",
  },
  polygon: {
    rpcEnv: "POLYGON_NODE_URL",
    gasPkEnv: "POLYGON_GAS_STATION_PRIVATE_KEY",
    minGasEnv: "POLYGON_MIN_GAS_MATIC",
    targetGasEnv: "POLYGON_TARGET_GAS_MATIC",
    defaultMinGas: "0.0008",
    defaultTargetGas: "0.0015",
  },
};

// ======================================================
//  EVM CHAINS (ETH / BSC / POLYGON)
// ======================================================

/**
 * Top up gas for EVM chain (ethereum | bsc | polygon)
 *
 * @param {string} chainName
 * @param {object} options
 * @param {boolean} options.dryRun
 * @param {string[]|null} options.addresses  // raw (not lowercased) addresses filter
 */
// ======================================================
//  EVM CHAINS (ETH / BSC / POLYGON)
// ======================================================

/**
 * Top up gas for EVM chain (ethereum | bsc | polygon)
 *
 * @param {string} chainName
 * @param {object} options
 * @param {boolean} options.dryRun
 * @param {string[]|null} options.addresses
 * @param {Array<{address:string, requiredWei?:string}>|null} options.requirements
 */
async function topupEvmChain(chainName, options = {}) {
  const { dryRun = false, addresses = null, requirements = null } = options;

  const cfg = CHAIN_CONFIGS[chainName];
  if (!cfg) {
    return {
      chain: chainName,
      dryRun,
      error: `No EVM config for chain ${chainName}`,
    };
  }

  const rpcUrl = process.env[cfg.rpcEnv];
  if (!rpcUrl) {
    return {
      chain: chainName,
      dryRun,
      error: `Missing RPC env: ${cfg.rpcEnv}`,
    };
  }

  const gasPk =
    process.env[cfg.gasPkEnv] || process.env.GAS_STATION_PRIVATE_KEY;
  if (!gasPk || !isProbablyPrivateKey(gasPk)) {
    return {
      chain: chainName,
      dryRun,
      error: `Missing or invalid gas private key: ${cfg.gasPkEnv} (or GAS_STATION_PRIVATE_KEY)`,
    };
  }

  const minGasStr = process.env[cfg.minGasEnv] || cfg.defaultMinGas;
  const targetGasStr = process.env[cfg.targetGasEnv] || cfg.defaultTargetGas;
  const minGasWei = ethers.utils.parseEther(minGasStr);
  const targetGasWei = ethers.utils.parseEther(targetGasStr);

  if (targetGasWei.lte(minGasWei)) {
    return {
      chain: chainName,
      dryRun,
      error: `targetGas <= minGas for ${chainName}. Check env ${cfg.minGasEnv}/${cfg.targetGasEnv}`,
    };
  }

  console.log(
    `\n=== [${chainName.toUpperCase()}] Gas Top-up Job (dryRun=${dryRun}) ===`
  );
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Min balance: ${minGasStr}`);
  console.log(`Target balance: ${targetGasStr}`);

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const gasWallet = new ethers.Wallet(gasPk, provider);
  const gasAddr = await gasWallet.getAddress();
  const gasBalance = await provider.getBalance(gasAddr);
  console.log(
    `[${chainName}] gas-station address: ${gasAddr}, balance=${ethers.utils.formatEther(
      gasBalance
    )}`
  );

  // ---------- EIP-1559 fee helper ----------
  const parseGwei = (g) =>
    ethers.BigNumber.from(ethers.utils.parseUnits(String(g), "gwei"));

  async function computeEip1559Fees() {
    const block = await provider.getBlock("latest");
    const baseFeePerGas =
      block && block.baseFeePerGas
        ? ethers.BigNumber.from(block.baseFeePerGas)
        : parseGwei(1);

    let priorityGwei;

    if (chainName === "polygon") {
      priorityGwei = Number(process.env.POLYGON_MIN_PRIORITY_GWEI || 25);
    } else if (chainName === "ethereum") {
      priorityGwei = Number(process.env.ETH_MIN_PRIORITY_GWEI || 2);
    } else if (chainName === "bsc") {
      priorityGwei = Number(process.env.BSC_MIN_PRIORITY_GWEI || 1.5);
    } else {
      priorityGwei = Number(process.env.EVM_MIN_PRIORITY_GWEI || 2);
    }

    const maxPriorityFeePerGas = parseGwei(priorityGwei);
    const maxFeePerGas = baseFeePerGas.mul(2).add(maxPriorityFeePerGas);

    return {
      baseFeePerGas,
      maxPriorityFeePerGas,
      maxFeePerGas,
    };
  }

  // map of per-address requiredWei coming from Sweeper
  const reqMap = new Map();
  if (Array.isArray(requirements)) {
    for (const r of requirements) {
      try {
        if (!r || !r.address || !r.requiredWei) continue;
        const addrLower = String(r.address).toLowerCase();
        const requiredWei = ethers.BigNumber.from(r.requiredWei);
        reqMap.set(addrLower, requiredWei);
      } catch (e) {
        console.warn(
          `[${chainName}] invalid requirement entry for ${(r && r.address) || "??"}:`,
          e.message || e
        );
      }
    }
    if (reqMap.size > 0) {
      console.log(
        `[${chainName}] requirements map loaded for ${reqMap.size} addresses`
      );
    }
  }

  // Mongo query for deposit addresses
  let docs;
  if (addresses && addresses.length > 0) {
    const addrsLower = addresses.map((a) => String(a).toLowerCase());
    console.log(
      `[${chainName}] filtering top-ups to specific addresses:`,
      addrsLower
    );
    docs = await Address.find({
      chain: chainName,
      address: { $in: addrsLower },
    }).lean();
  } else {
    docs = await Address.find({ chain: chainName }).lean();
  }

  if (!docs.length) {
    console.log(
      `[${chainName}] no deposit addresses in DB for given filter`
    );
    return {
      chain: chainName,
      dryRun,
      checked: 0,
      toppedUp: 0,
      items: [],
      note: "no deposit addresses",
    };
  }

  console.log(
    `[${chainName}] found ${docs.length} deposit addresses to check`
  );

  const resultItems = [];
  let toppedUp = 0;
  let checked = 0;

  for (const doc of docs) {
    const addr = doc.address;
    if (!addr) continue;
    checked++;

    const addrLower = String(addr).toLowerCase();
    const specificRequiredWei = reqMap.get(addrLower);

    try {
      const bal = await provider.getBalance(addr);
      const balEth = ethers.utils.formatEther(bal);

      console.log(
        `[${chainName}] ${addr} balance = ${balEth} (native)`
      );

      // New "exact gas" mode: Sweeper told us total requiredWei for this address
      if (specificRequiredWei) {
        const neededTotal = specificRequiredWei;

        if (bal.gte(neededTotal)) {
          resultItems.push({
            address: addr,
            currentBalance: balEth,
            action: "none",
            reason: "balance >= requiredWei",
            mode: "requiredWei",
          });
          continue;
        }

        const toSend = neededTotal.sub(bal);
        const toSendEth = ethers.utils.formatEther(toSend);

        console.log(
          `[${chainName}] ➜ exact-topup required for ${addr}, amount=${toSendEth}`
        );

        const gasBalNow = await provider.getBalance(gasAddr);
        if (gasBalNow.lt(toSend)) {
          console.warn(
            `[${chainName}] gas-station low balance, cannot top up ${addr}`
          );
          resultItems.push({
            address: addr,
            currentBalance: balEth,
            action: "skipped",
            reason: "gas-station low balance",
            mode: "requiredWei",
          });
          continue;
        }

        if (dryRun) {
          resultItems.push({
            address: addr,
            currentBalance: balEth,
            action: "would-topup",
            amount: toSendEth,
            mode: "requiredWei",
          });
          continue;
        }

        const { maxPriorityFeePerGas, maxFeePerGas } =
          await computeEip1559Fees();

        const tx = await gasWallet.sendTransaction({
          to: addr,
          value: toSend,
          gasLimit: 21000,
          maxPriorityFeePerGas,
          maxFeePerGas,
        });

        console.log(
          `[${chainName}] Exact top-up tx sent to ${addr}: ${tx.hash}`
        );
        await tx.wait();

        toppedUp++;
        resultItems.push({
          address: addr,
          currentBalance: balEth,
          action: "topped-up",
          amount: toSendEth,
          txHash: tx.hash,
          mode: "requiredWei",
        });

        await sleep(400);
        continue;
      }

      // Old behaviour: minGas / targetGas (for cron / generic calls)
      if (bal.gte(minGasWei)) {
        resultItems.push({
          address: addr,
          currentBalance: balEth,
          action: "none",
          reason: "balance >= minGas",
        });
        continue;
      }

      const needed = targetGasWei.sub(bal);
      const neededEth = ethers.utils.formatEther(needed);

      console.log(
        `[${chainName}] ➜ top-up required for ${addr}, amount=${neededEth}`
      );

      const gasBalNow = await provider.getBalance(gasAddr);
      if (gasBalNow.lt(needed)) {
        console.warn(
          `[${chainName}] gas-station low balance, cannot top up ${addr}`
        );
        resultItems.push({
          address: addr,
          currentBalance: balEth,
          action: "skipped",
          reason: "gas-station low balance",
        });
        continue;
      }

      if (dryRun) {
        // simulate only
        resultItems.push({
          address: addr,
          currentBalance: balEth,
          action: "would-topup",
          amount: neededEth,
        });
        continue;
      }

      const { maxPriorityFeePerGas, maxFeePerGas } =
        await computeEip1559Fees();

      const tx = await gasWallet.sendTransaction({
        to: addr,
        value: needed,
        gasLimit: 21000,
        maxPriorityFeePerGas,
        maxFeePerGas,
      });

      console.log(
        `[${chainName}] Top-up tx sent to ${addr}: ${tx.hash}`
      );
      await tx.wait();

      toppedUp++;
      resultItems.push({
        address: addr,
        currentBalance: balEth,
        action: "topped-up",
        amount: neededEth,
        txHash: tx.hash,
      });

      await sleep(400);
    } catch (err) {
      console.error(
        `[${chainName}] error with ${addr}:`,
        err.message || err
      );
      resultItems.push({
        address: addr,
        action: "error",
        error: err.message || String(err),
      });
    }
  }

  return {
    chain: chainName,
    dryRun,
    checked,
    toppedUp,
    items: resultItems,
  };
}



// ======================================================
//  TRON TOP-UP
// ======================================================

/**
 * Top up TRX gas for Tron deposit addresses.
 *
 * Env:
 *   TRON_NODE_URL
 *   TRON_GAS_STATION_PRIVATE_KEY
 *   TRON_MIN_GAS_TRX   (e.g. "5")
 *   TRON_TARGET_GAS_TRX (e.g. "8")
 */
async function topupTron({ dryRun = false, addresses = null, requirements = null } = {}) {
  const fullHost = process.env.TRON_NODE_URL;
  if (!fullHost) {
    return {
      chain: "tron",
      dryRun,
      error: "Missing TRON_NODE_URL",
    };
  }

  const gasPk =
    (process.env.TRON_GAS_STATION_PRIVATE_KEY || "").replace(/^0x/, "");
  if (!gasPk || gasPk.length === 0) {
    return {
      chain: "tron",
      dryRun,
      error: "Missing TRON_GAS_STATION_PRIVATE_KEY",
    };
  }

  const minStr = process.env.TRON_MIN_GAS_TRX || "5";
  const targetStr = process.env.TRON_TARGET_GAS_TRX || "8";
  const MIN_SUN = Math.round(parseFloat(minStr) * 1e6);
  const TARGET_SUN = Math.round(parseFloat(targetStr) * 1e6);
  if (!(TARGET_SUN > MIN_SUN)) {
    return {
      chain: "tron",
      dryRun,
      error:
        "TRON_TARGET_GAS_TRX must be greater than TRON_MIN_GAS_TRX",
    };
  }

  console.log(
    `\n=== [TRON] Gas Top-up Job (dryRun=${dryRun}) ===`
  );
  console.log(`TRON_NODE_URL: ${fullHost}`);
  console.log(`Min balance: ${minStr} TRX`);
  console.log(`Target balance: ${targetStr} TRX`);

  const tronWebGas = new TronWeb({
    fullHost,
    privateKey: gasPk,
  });

  const gasBase58 = tronWebGas.address.fromPrivateKey(gasPk);
  const gasBalSun = await tronWebGas.trx.getBalance(gasBase58);
  console.log(
    `[tron] gas-station address: ${gasBase58}, balance=${(
      gasBalSun / 1e6
    ).toFixed(6)} TRX`
  );

  // 🔥 Build requirements map: address -> requiredSun
  const reqMap = new Map();
  if (Array.isArray(requirements)) {
    for (const r of requirements) {
      try {
        if (!r || !r.address || r.requiredSun == null) continue;
        // Tron addresses are base58, case-sensitive (no lowercase).
        const addrKey = String(r.address);
        const requiredSun = BigInt(r.requiredSun.toString());
        reqMap.set(addrKey, requiredSun);
      } catch (e) {
        console.warn(
          `[tron] invalid requirement entry for ${(r && r.address) || "??"}:`,
          e.message || e
        );
      }
    }
    if (reqMap.size > 0) {
      console.log(`[tron] requirements map loaded for ${reqMap.size} addresses`);
    }
  }

  // Mongo query
  let docs;
  if (addresses && addresses.length > 0) {
    console.log("[tron] filtering to specific addresses:", addresses);
    docs = await Address.find({
      chain: "tron",
      address: { $in: addresses },
    }).lean();
  } else {
    docs = await Address.find({ chain: "tron" }).lean();
  }

  if (!docs.length) {
    console.log("[tron] no deposit addresses to check");
    return {
      chain: "tron",
      dryRun,
      checked: 0,
      toppedUp: 0,
      items: [],
      note: "no deposit addresses",
    };
  }

  console.log(`[tron] found ${docs.length} deposit addresses`);

  const items = [];
  let checked = 0;
  let toppedUp = 0;

  for (const doc of docs) {
    const addr = doc.address;
    if (!addr) continue;
    checked++;

    // exact match – no lowercase
    const specificRequiredSun = reqMap.get(addr);

    try {
      const balSun = BigInt(await tronWebGas.trx.getBalance(addr));
      const balTrx = Number(balSun) / 1e6;
      console.log(
        `[tron] ${addr} balance = ${balTrx.toFixed(6)} TRX`
      );

      // New exact mode: Sweeper requested requiredSun
      if (specificRequiredSun) {
        const neededTotal = specificRequiredSun; // total desired balance (sun)

        if (balSun >= neededTotal) {
          items.push({
            address: addr,
            currentBalance: balTrx.toFixed(6),
            action: "none",
            reason: "balance >= requiredSun",
            mode: "requiredSun",
          });
          continue;
        }

        const toSend = neededTotal - balSun;
        const toSendTrx = Number(toSend) / 1e6;

        console.log(
          `[tron] ➜ exact-topup required for ${addr}, amount=${toSendTrx.toFixed(6)} TRX`
        );

        const gasBalNow = BigInt(await tronWebGas.trx.getBalance(gasBase58));
        if (gasBalNow < toSend) {
          console.warn(
            `[tron] gas-station low balance, cannot top up ${addr}`
          );
          items.push({
            address: addr,
            currentBalance: balTrx.toFixed(6),
            action: "skipped",
            reason: "gas-station low balance",
            mode: "requiredSun",
          });
          continue;
        }

        if (dryRun) {
          items.push({
            address: addr,
            currentBalance: balTrx.toFixed(6),
            action: "would-topup",
            amount: toSendTrx.toFixed(6),
            mode: "requiredSun",
          });
          continue;
        }

        const resp = await tronWebGas.trx.sendTransaction(
          addr,
          Number(toSend)
        );
        const txid = resp && (resp.txid || resp.transaction || resp);
        console.log(
          `[tron] Exact top-up tx sent to ${addr}: ${txid} amount=${toSendTrx.toFixed(
            6
          )} TRX`
        );

        toppedUp++;
        items.push({
          address: addr,
          currentBalance: balTrx.toFixed(6),
          action: "topped-up",
          amount: toSendTrx.toFixed(6),
          txHash: txid,
          mode: "requiredSun",
        });

        await sleep(500);
        continue;
      }

      // Old behaviour: MIN_SUN / TARGET_SUN (for generic jobs)
      if (balSun >= BigInt(MIN_SUN)) {
        items.push({
          address: addr,
          currentBalance: balTrx.toFixed(6),
          action: "none",
          reason: "balance >= minGas",
        });
        continue;
      }

      const needed = BigInt(TARGET_SUN) - balSun;
      const neededTrx = Number(needed) / 1e6;
      console.log(
        `[tron] ➜ top-up required for ${addr}, amount=${neededTrx.toFixed(
          6
        )} TRX`
      );

      const gasBalNow = BigInt(await tronWebGas.trx.getBalance(gasBase58));
      if (gasBalNow < needed) {
        console.warn(
          `[tron] gas-station low balance, cannot top up ${addr}`
        );
        items.push({
          address: addr,
          currentBalance: balTrx.toFixed(6),
          action: "skipped",
          reason: "gas-station low balance",
        });
        continue;
      }

      if (dryRun) {
        items.push({
          address: addr,
          currentBalance: balTrx.toFixed(6),
          action: "would-topup",
          amount: neededTrx.toFixed(6),
        });
        continue;
      }

      const resp = await tronWebGas.trx.sendTransaction(
        addr,
        Number(needed)
      );
      const txid = resp && (resp.txid || resp.transaction || resp);
      console.log(
        `[tron] Top-up tx sent to ${addr}: ${txid} amount=${neededTrx.toFixed(
          6
        )} TRX`
      );

      toppedUp++;
      items.push({
        address: addr,
        currentBalance: balTrx.toFixed(6),
        action: "topped-up",
        amount: neededTrx.toFixed(6),
        txHash: txid,
      });

      await sleep(500);
    } catch (e) {
      console.error(
        `[tron] error with ${addr}:`,
        e.message || e
      );
      items.push({
        address: addr,
        action: "error",
        error: e.message || String(e),
      });
    }
  }

  return {
    chain: "tron",
    dryRun,
    checked,
    toppedUp,
    items,
  };
}
// ======================================================
//  SOLANA TOP-UP
// ======================================================

/**
 * Top up SOL for Solana deposit addresses.
 *
 * Env:
 *   SOLANA_RPC_URL
 *   SOL_GAS_STATION_PRIVATE_KEY  (or ADMIN_WALLET_PRIVATE_KEY_SOL)
 *   SOL_MIN_GAS_SOL      (e.g. "0.001")
 *   SOL_TARGET_GAS_SOL   (e.g. "0.005")
 */
async function topupSolana({ dryRun = false, addresses = null } = {}) {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) {
    return {
      chain: "solana",
      dryRun,
      error: "Missing SOLANA_RPC_URL",
    };
  }

  const rawKey =
    process.env.SOL_GAS_STATION_PRIVATE_KEY ||
    process.env.ADMIN_WALLET_PRIVATE_KEY_SOL;
  if (!rawKey) {
    return {
      chain: "solana",
      dryRun,
      error:
        "Missing SOL_GAS_STATION_PRIVATE_KEY or ADMIN_WALLET_PRIVATE_KEY_SOL",
    };
  }

  const minStr = process.env.SOL_MIN_GAS_SOL || "0.001";
  const targetStr = process.env.SOL_TARGET_GAS_SOL || "0.005";
  const minLamports = BigInt(
    Math.floor(parseFloat(minStr) * Number(LAMPORTS_PER_SOL))
  );
  const targetLamports = BigInt(
    Math.floor(parseFloat(targetStr) * Number(LAMPORTS_PER_SOL))
  );
  if (!(targetLamports > minLamports)) {
    return {
      chain: "solana",
      dryRun,
      error:
        "SOL_TARGET_GAS_SOL must be greater than SOL_MIN_GAS_SOL",
    };
  }

  console.log(
    `\n=== [SOLANA] Gas Top-up Job (dryRun=${dryRun}) ===`
  );
  console.log(`RPC: ${rpc}`);
  console.log(`Min balance: ${minStr} SOL`);
  console.log(`Target balance: ${targetStr} SOL`);

  const connection = new Connection(rpc, "confirmed");
  const gasKeypair = loadSolKey(rawKey);
  const gasPubkey = gasKeypair.publicKey;
  const gasBalanceLamports = BigInt(
    await connection.getBalance(gasPubkey)
  );
  const gasBalanceSol =
    Number(gasBalanceLamports) / Number(LAMPORTS_PER_SOL);
  console.log(
    `[solana] gas-station pubkey: ${gasPubkey.toBase58()}, balance=${gasBalanceSol} SOL`
  );

  // Mongo query
  let docs;
  if (addresses && addresses.length > 0) {
    console.log("[solana] filtering to specific addresses:", addresses);
    docs = await Address.find({
      chain: "solana",
      address: { $in: addresses },
    }).lean();
  } else {
    docs = await Address.find({ chain: "solana" }).lean();
  }

  if (!docs.length) {
    console.log("[solana] no deposit addresses to check");
    return {
      chain: "solana",
      dryRun,
      checked: 0,
      toppedUp: 0,
      items: [],
      note: "no deposit addresses",
    };
  }

  console.log(`[solana] found ${docs.length} deposit addresses`);

  const items = [];
  let checked = 0;
  let toppedUp = 0;

  for (const doc of docs) {
    const addr = doc.address;
    if (!addr) continue;
    checked++;

    try {
      const destPubkey = new PublicKey(addr);
      const balLamports = BigInt(await connection.getBalance(destPubkey));
      const balSol =
        Number(balLamports) / Number(LAMPORTS_PER_SOL);

      console.log(
        `[solana] ${addr} balance = ${balSol} SOL`
      );

      if (balLamports >= minLamports) {
        items.push({
          address: addr,
          currentBalance: balSol.toString(),
          action: "none",
          reason: "balance >= minGas",
        });
        continue;
      }

      const needed = targetLamports - balLamports;
      const neededSol =
        Number(needed) / Number(LAMPORTS_PER_SOL);

      console.log(
        `[solana] ➜ top-up required for ${addr}, amount=${neededSol} SOL`
      );

      if (gasBalanceLamports < needed) {
        console.warn(
          `[solana] gas-station low balance, cannot top up ${addr}`
        );
        items.push({
          address: addr,
          currentBalance: balSol.toString(),
          action: "skipped",
          reason: "gas-station low balance",
        });
        continue;
      }

      if (dryRun) {
        items.push({
          address: addr,
          currentBalance: balSol.toString(),
          action: "would-topup",
          amount: neededSol.toString(),
        });
        continue;
      }

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: gasPubkey,
          toPubkey: destPubkey,
          lamports: Number(needed),
        })
      );

      const sig = await sendAndConfirmTransaction(
        connection,
        tx,
        [gasKeypair],
        { commitment: "confirmed" }
      );

      console.log(
        `[solana] Top-up tx sent to ${addr}: ${sig}`
      );

      toppedUp++;
      items.push({
        address: addr,
        currentBalance: balSol.toString(),
        action: "topped-up",
        amount: neededSol.toString(),
        txHash: sig,
      });

      await sleep(500);
    } catch (e) {
      console.error(
        `[solana] error with ${addr}:`,
        e.message || e
      );
      items.push({
        address: addr,
        action: "error",
        error: e.message || String(e),
      });
    }
  }

  return {
    chain: "solana",
    dryRun,
    checked,
    toppedUp,
    items,
  };
}


// ======================================================
//  EXPRESS API
// ======================================================

const app = express();
app.use(bodyParser.json());

app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

/**
 * POST /api/topup-gas
 * body:
 *   {
 *     "chain": "ethereum" | "bsc" | "polygon" | "tron" | "solana" | "btc" | "all" (default: "all")
 *     "dryRun": true | false
 *     "addresses": ["0x...", "..."]  // optional filter, sweeper can pass [depositAddress]
 *   }
 */
app.post("/api/topup-gas", async (req, res) => {
  try {
    const body = req.body || {};
    const chain = (body.chain || "all").toLowerCase();
    const dryRun = body.dryRun === true || body.dryRun === "true";

    let addresses = null;
    if (Array.isArray(body.addresses) && body.addresses.length > 0) {
      addresses = body.addresses.filter((a) => typeof a === "string");
    }

    // NEW: exact per-address requirements from sweeper
    let requirements = null;
    if (Array.isArray(body.requirements) && body.requirements.length > 0) {
      requirements = body.requirements.filter(
        (r) => r && typeof r.address === "string"
      );
    }

    const allowed = [
      "ethereum",
      "bsc",
      "polygon",
      "tron",
      "solana",
      "all",
    ];
    if (!allowed.includes(chain)) {
      return res.status(400).json({
        error:
          "chain must be one of: ethereum | bsc | polygon | tron | solana | all",
      });
    }

    let chainsToRun;
    if (chain === "all") {
      chainsToRun = ["ethereum", "bsc", "polygon", "tron", "solana"];
      // BTC omitted from "all" by default, you could add it if you want.
    } else {
      chainsToRun = [chain];
    }

    const results = [];

     for (const c of chainsToRun) {
      if (c === "ethereum" || c === "bsc" || c === "polygon") {
        results.push(
          await topupEvmChain(c, { dryRun, addresses, requirements })
        );
       } else if (c === "tron") {
    results.push(await topupTron({ dryRun, addresses, requirements }));
      } else if (c === "solana") {
        results.push(await topupSolana({ dryRun, addresses }));
      }
    }

    return res.json({
      ok: true,
      dryRun,
      results,
    });
  } catch (err) {
    console.error("topup-gas API error:", err.stack || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal_error",
    });
  }
});

// Health check
app.get("/health", (_req, res) =>
  res.json({ ok: true, ts: Date.now(), service: "topupGasApi" })
);

// ---------- Start server ----------
const PORT = process.env.TOPUP_PORT || 4100;
app.listen(PORT, () => {
  console.log(`topupGas API listening on port ${PORT}`);
});

