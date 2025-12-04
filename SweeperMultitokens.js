
// SweeperMultitokens.js  (or sweeper-api.js)
require("dotenv").config();
const { ethers } = require("ethers");
const TronWeb = require("tronweb");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const bitcoin = require("bitcoinjs-lib");
const axios = require("axios");
const {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} = require("@solana/web3.js");
const splToken = require("@solana/spl-token");
const _bs58 = require("bs58");
const bs58 = _bs58 && _bs58.default ? _bs58.default : _bs58;

// models
const TransactionModel = require("./src/models/transactionmodels");
const Address = require("./src/models/Wallets");

// ---------- HD generator import ----------
const { generateWalletFromMnemonic } = require("./generateMultichainwallets");


// ---------- Utilities ----------
function isProbablyPrivateKey(pk) {
  if (!pk || typeof pk !== "string") return false;
  const s = pk.startsWith("0x") ? pk.slice(2) : pk;
  return /^[0-9a-fA-F]{64}$/.test(s);
}
function truthy(v) {
  if (v === true || v === "true") return true;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.toLowerCase());
  return Boolean(v);
}

// ---------- Gas top-up via topupgas API (EVM chains) ----------
const GAS_TOPUP_API_URL =
  process.env.GAS_TOPUP_API_URL || "http://localhost:4100/api/topup-gas";

/**
 * Call the external gas top-up microservice.
 * The microservice holds the gas-station private key; this sweeper does NOT.
 *
 * @param {string} chain       "ethereum" | "bsc" | "polygon"
 * @param {string[]} addresses deposit addresses to top up
 * @param {boolean} dryRun     if true, just simulate/log in the topup service
 */
async function requestGasTopup(
  chain,
  addresses,
  dryRun = false,
  requirements = null
) {
  try {
    console.log(
      `[gasTopup] Requesting gas for chain=${chain}, addresses=${Array.isArray(addresses) ? addresses.join(",") : "n/a"}, dryRun=${dryRun}`
    );

    const body = {
      chain,
      addresses,
      dryRun,
    };

    if (Array.isArray(requirements) && requirements.length > 0) {
      body.requirements = requirements;
    }

    const res = await axios.post(GAS_TOPUP_API_URL, body);
    console.log(
      `[gasTopup] API response (${chain}):`,
      typeof res.data === "object" ? JSON.stringify(res.data) : res.data
    );
  } catch (err) {
    console.error(
      `[gasTopup] Error calling topup API for chain=${chain}:`,
      err.response?.data || err.message || err
    );
    throw err;
  }
}

/**
 * Wait until an address has at least `minWei` balance, or timeout.
 */
async function waitForGasBalance(provider, address, minWei, opts = {}) {
  const { maxTries = 10, delayMs = 3000 } = opts;

  for (let i = 0; i < maxTries; i++) {
    const bal = await provider.getBalance(address);
    if (bal.gte(minWei)) {
      console.log(
        `[waitForGasBalance] ${address} has enough native: ${ethers.utils.formatEther(
          bal
        )} >= ${ethers.utils.formatEther(minWei)}`
      );
      return true;
    }
    console.log(
      `[waitForGasBalance] ${address} still low: ${ethers.utils.formatEther(
        bal
      )} < ${ethers.utils.formatEther(minWei)}, retry ${i + 1}/${maxTries}`
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Ensure an EVM deposit address has enough native coin to pay `feeNeeded`.
 * If not, request gas top-up from the external service.
 */
async function ensureGasForEvmUser(provider, chainName, userAddress, feeNeeded) {
  const currentBal = await provider.getBalance(userAddress);
  if (currentBal.gte(feeNeeded)) {
    // Already enough gas
    return;
  }

  const missing = feeNeeded.sub(currentBal);
  console.log(
    `[${chainName}] ${userAddress} balance=${ethers.utils.formatEther(
      currentBal
    )} < needed=${ethers.utils.formatEther(
      feeNeeded
    )}. Requesting top-up of ${ethers.utils.formatEther(missing)}...`
  );

  // pass exact requiredWei (in wei, as string)
  await requestGasTopup(
    chainName,
    [userAddress],
    false,
    [
      {
        address: userAddress,
        requiredWei: feeNeeded.toString(), // total needed gas for sweep
      },
    ]
  );

  const ok = await waitForGasBalance(provider, userAddress, feeNeeded, {
    maxTries: 10,
    delayMs: 3000,
  });
  if (!ok) {
    throw new Error(
      `[${chainName}] gas top-up did not reach required balance for ${userAddress}`
    );
  }
}


// ---------- Solana gas top-up via topupgas API ----------
async function ensureSolGasForUser(connection, userPubkey, minLamports, opts = {}) {
  const { maxTries = 10, delayMs = 3000 } = opts;
  const addrStr = userPubkey.toBase58();

  // 1. Check current balance
  let bal = BigInt(await connection.getBalance(userPubkey));
  if (bal >= minLamports) {
    console.log(
      `[solana] ${addrStr} already has enough SOL: ` +
      `${Number(bal) / Number(LAMPORTS_PER_SOL)} >= ` +
      `${Number(minLamports) / Number(LAMPORTS_PER_SOL)}`
    );
    return;
  }

  console.log(
    `[solana] ${addrStr} balance=${Number(bal) / Number(
      LAMPORTS_PER_SOL
    )} SOL < needed=${Number(minLamports) / Number(
      LAMPORTS_PER_SOL
    )} SOL. Requesting top-up...`
  );

  // 2. Ask your topup-gas microservice to fund this address
  await requestGasTopup("solana", [addrStr], false);

  // 3. Poll until balance is enough or timeout
  for (let i = 0; i < maxTries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    bal = BigInt(await connection.getBalance(userPubkey));
    if (bal >= minLamports) {
      console.log(
        `[solana] ${addrStr} now has enough SOL: ` +
        `${Number(bal) / Number(LAMPORTS_PER_SOL)} >= ` +
        `${Number(minLamports) / Number(LAMPORTS_PER_SOL)}`
      );
      return;
    }
    console.log(
      `[solana] waiting for SOL topup for ${addrStr}: ` +
      `${Number(bal) / Number(LAMPORTS_PER_SOL)} < ` +
      `${Number(minLamports) / Number(LAMPORTS_PER_SOL)} ` +
      `(try ${i + 1}/${maxTries})`
    );
  }

  throw new Error(
    `[solana] gas top-up did not reach required balance for ${addrStr}`
  );
}


// ---------- Tron gas top-up via topupgas API ----------
async function ensureTronGasForUser(fullHost, userAddress, minSun, opts = {}) {
  const { maxTries = 10, delayMs = 5000 } = opts;

  const tronWebReadonly = new TronWeb({ fullHost });

  // Check current balance
  let bal = await tronWebReadonly.trx.getBalance(userAddress);
  if (bal >= minSun) {
    console.log(
      `[tron] ${userAddress} already has enough TRX gas: ${(bal / 1e6).toFixed(
        6
      )} >= ${(minSun / 1e6).toFixed(6)}`
    );
    return;
  }

  console.log(
    `[tron] ${userAddress} TRX balance=${(bal / 1e6).toFixed(
      6
    )} < needed=${(minSun / 1e6).toFixed(
      6
    )} – requesting topup via topupGas API...`
  );

  // Ask topupGas API to bring this address to exactly `minSun` (requiredSun mode)
  await requestGasTopup(
    "tron",
    [userAddress],
    false,
    [
      {
        address: userAddress,
        requiredSun: String(minSun), // total desired balance in sun
      },
    ]
  );

  // 3️⃣ Poll Tron node until balance >= minSun or timeout
  for (let i = 0; i < maxTries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));

    bal = await tronWebReadonly.trx.getBalance(userAddress);
    if (bal >= minSun) {
      console.log(
        `[tron] topup confirmed for ${userAddress}: now ${(bal / 1e6).toFixed(
          6
        )} TRX >= ${(minSun / 1e6).toFixed(6)}`
      );
      return;
    }

    console.log(
      `[tron] waiting for topup for ${userAddress}: ${(bal / 1e6).toFixed(
        6
      )} < ${(minSun / 1e6).toFixed(6)} (try ${i + 1}/${maxTries})`
    );
  }

  // 4️⃣ Soft fail: log warning, but DO NOT throw
  const finalTrx = (bal / 1e6).toFixed(6);
  const requiredTrx = (minSun / 1e6).toFixed(6);

  console.warn(
    `[tron] WARNING: gas top-up tx sent but balance for ${userAddress} did not reach required=${requiredTrx} TRX (have=${finalTrx} TRX). Proceeding anyway.`
  );
  // just return; caller decides what to do next
  return;
}

// --------- Helper: derive per-chain wallets from Mongo Address + HD mnemonic ---------

/**
 * For a given chainName, load all deposit addresses from Mongo Address,
 * then re-derive the corresponding private keys using generateWalletFromMnemonic + index.
 *
 * Returns: [{ address, privateKey, index, userId }, ...]
 */
async function getChainUsers(chainName) {
  const docs = await Address.find({ chain: chainName }).lean();
  const users = [];

  for (const doc of docs) {
    if (typeof doc.index !== "number" && typeof doc.index !== "string") continue;
    const index = Number(doc.index);

    try {
      const walletObj = generateWalletFromMnemonic(undefined, { index });

      let sub;
      switch (chainName) {
        case "ethereum":
          sub = walletObj.ethereum;
          break;
        case "bsc":
          sub = walletObj.bsc;
          break;
        case "polygon":
          sub = walletObj.polygon;
          break;
        case "tron":
          sub = walletObj.tron;
          break;
        case "btc":
        case "bitcoin":
          sub = walletObj.btc;
          break;
        case "solana":
          sub = walletObj.solana;
          break;
        default:
          console.warn(`[getChainUsers] unsupported chainName=${chainName}`);
          continue;
      }
      if (!sub || !sub.address) {
        console.warn(
          `[getChainUsers:${chainName}] no derived sub-wallet for index ${index}`
        );
        continue;
      }

      // sanity check: address mismatch (log only)
      if (
        String(sub.address).toLowerCase() !==
        String(doc.address || "").toLowerCase()
      ) {
        console.warn(
          `[getChainUsers:${chainName}] address mismatch index=${index} ` +
            `derived=${sub.address} db=${doc.address}`
        );
      }

      users.push({
        address: sub.address,
        privateKey: sub.privateKey, // evm: 0x..., tron: 0x..., btc: WIF, solana: base58
        index,
        userId: doc.userId,
      });
    } catch (e) {
      console.error(
        `[getChainUsers:${chainName}] failed for index=${doc.index}:`,
        e.message || e
      );
    }
  }

  console.log(
    `[getChainUsers] chain=${chainName} => ${users.length} derived wallets`
  );
  return users;
}

// ---------- Job runner helper ----------
async function runChainSweep(chainName, options = {}) {
  const force = !!options.force;
  switch (chainName) {
    case "ethereum":
    case "bsc":
      return await evmSweep(chainName, force);
    case "polygon":
      return await polygonSweep(force);
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

// ========================= EVM (ETH / BSC) =========================
async function evmSweep(chainName, isForce = false) {
  console.log("[evmSweep] start", chainName, "force=", isForce);

  const erc20Abi = require("./erc20.json");
  const tokensPath =
    chainName === "ethereum" ? "./tokenethereum.json" : "./tokenbsc.json";
  const tokens = require(path.resolve(tokensPath));

  // Get users from Mongo + HD-derivation
  const users = await getChainUsers(chainName);
  if (!users.length) {
    console.log(`[evmSweep:${chainName}] no deposit users found, skipping`);
    return { ok: true, chain: chainName, msg: "no users" };
  }

  const provider = new ethers.providers.JsonRpcProvider(
    chainName === "ethereum" ? process.env.ETH_NODE_URL : process.env.BSC_NODE_URL
  );

  const destination = process.env.ADMIN_WALLET;
  if (!destination) throw new Error("Missing ADMIN_WALLET in env");

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
        console.error(
          `Error reading ${tokenInfo.symbol} for ${user.address}: ${e.message}`
        );
      }
    }

    console.log(
      `[${chainName}] Eligible ${tokenInfo.symbol}: ${ethers.utils.formatUnits(
        totalEligible,
        tokenInfo.decimals
      )}`
    );
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
          gasLimit = await token
            .connect(userWallet)
            .estimateGas.transfer(destination, user.balance, {
              from: user.address,
            });
        } catch {
          gasLimit = ethers.BigNumber.from(90000);
        }
        const feeNeeded = addBuffer20(gasLimit.mul(gasPrice));

        // 🔐 Ensure gas using external topup service (no PK here)
        await ensureGasForEvmUser(provider, chainName, user.address, feeNeeded);

        const tx = await token.connect(userWallet).transfer(destination, user.balance, {
          gasPrice,
          gasLimit: addBuffer20(gasLimit),
        });
        console.log(
          `Swept ${tokenInfo.symbol} from ${user.address}: ${tx.hash}`
        );
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
        console.error(
          `Failed ${tokenInfo.symbol} from ${user.address}: ${err.message}`
        );
      }
    }
  }

  // Native sweep (gas comes from same balance; no external topup needed)
  let nativeTotal = ethers.BigNumber.from(0);
  const nativeUsers = [];
  for (const user of users) {
    if (
      !user ||
      !user.address ||
      !user.privateKey ||
      !isProbablyPrivateKey(user.privateKey)
    )
      continue;
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
      console.log(
        `Swept native ${chainName} from ${user.address} => ${tx.hash}`
      );
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
      console.error(
        `Native sweep failed for ${user.address}: ${err.message}`
      );
    }
  }

  return { ok: true, chain: chainName };
}

// ----------------- POLYGON (EVM, but separate config) -----------------
async function polygonSweep(isForce = false) {
  const erc20Abi = require("./erc20.json");
  const tokensPath = "./tokenpolygon.json";

  const MIN_PRIORITY_GWEI = Number(process.env.POLYGON_MIN_PRIORITY_GWEI || 25);

  const rpcEnv = process.env.POLYGON_NODE_URL;
  if (!rpcEnv) throw new Error("Missing POLYGON_NODE_URL");
  const provider = new ethers.providers.JsonRpcProvider(rpcEnv);

  const destination =
    process.env.ADMIN_WALLET_POLYGON ||
    process.env.ADMIN_WALLET ||
    process.env.ADMIN_WALLET_ETH;
  if (!destination) throw new Error("Missing ADMIN_WALLET_POLYGON / ADMIN_WALLET");

  // Get polygon deposit users from Mongo + HD derivation
  let users = await getChainUsers("polygon");
  if (!users.length) {
    console.log("[polygonSweep] no deposit users found, skipping");
    return { ok: true, chain: "polygon", msg: "no users" };
  }

  let tokens = [];
  try {
    tokens = require(path.resolve(tokensPath));
  } catch (e) {
    console.warn(`Could not load ${tokensPath}: ${e.message}`);
  }

  const parseGwei = (g) =>
    ethers.BigNumber.from(ethers.utils.parseUnits(String(g), "gwei"));

  async function computeFees(priorityGwei) {
    const block = await provider.getBlock("latest");
    const baseFeePerGas =
      block && block.baseFeePerGas
        ? ethers.BigNumber.from(block.baseFeePerGas)
        : parseGwei(1);
    const priority = parseGwei(priorityGwei);
    const maxFee = baseFeePerGas.mul(2).add(priority);
    return {
      baseFeePerGas,
      maxPriorityFeePerGas: priority,
      maxFeePerGas: maxFee,
    };
  }

  async function ensureFundedForFee(userAddr, feeNeededBN, eipFees) {
    // eipFees is not used here, but we keep the signature for compatibility
    const balNow = await provider.getBalance(userAddr);
    if (balNow.gte(feeNeededBN)) return { funded: false };

    console.log(
      `[polygon] ${userAddr} has ${ethers.utils.formatEther(
        balNow
      )} MATIC, needs ~${ethers.utils.formatEther(
        feeNeededBN
      )} for tx. Requesting gas top-up...`
    );

    await requestGasTopup("polygon", [userAddr], false);

    const ok = await waitForGasBalance(provider, userAddr, feeNeededBN, {
      maxTries: 10,
      delayMs: 3000,
    });

    if (!ok) {
      throw new Error(
        `[polygon] gas top-up did not reach required balance for ${userAddr}`
      );
    }
    return { funded: true };
  }

  // token sweep
  for (const tokenInfo of tokens) {
    if (!tokenInfo || !tokenInfo.address) continue;
    const token = new ethers.Contract(tokenInfo.address, erc20Abi, provider);
    const userThreshold = ethers.utils.parseUnits(
      tokenInfo.userThreshold || "50",
      tokenInfo.decimals || 18
    );
    const exchangeThreshold = ethers.utils.parseUnits(
      tokenInfo.exchangeThreshold || "100",
      tokenInfo.decimals || 18
    );

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
        console.error(
          `Error reading ${tokenInfo.symbol || tokenInfo.address} for ${
            user.address
          }: ${e.message}`
        );
      }
    }

    console.log(
      `[polygon] Eligible ${
        tokenInfo.symbol || tokenInfo.address
      }: ${ethers.utils.formatUnits(totalEligible, tokenInfo.decimals || 18)}`
    );
    if (totalEligible.lt(exchangeThreshold) && !isForce) {
      console.log(
        `Skipping ${tokenInfo.symbol || tokenInfo.address}: threshold not met`
      );
      continue;
    }

    for (const user of eligibleUsers) {
      let userWallet;
      try {
        userWallet = new ethers.Wallet(user.privateKey, provider);
      } catch (e) {
        console.error(`Invalid privateKey ${user.address}: ${e.message}`);
        continue;
      }

      try {
        let gasLimit;
        try {
          gasLimit = await token
            .connect(userWallet)
            .estimateGas.transfer(destination, user.balance, {
              from: user.address,
            });
        } catch {
          gasLimit = ethers.BigNumber.from(90000);
        }

        const eipFees = await computeFees(MIN_PRIORITY_GWEI);
        console.log(
          `[polygon][fee] user=${user.address} gasLimit=${gasLimit.toString()} priority=${ethers.utils.formatUnits(
            eipFees.maxPriorityFeePerGas,
            "gwei"
          )} gwei maxFee=${ethers.utils.formatUnits(
            eipFees.maxFeePerGas,
            "gwei"
          )} gwei baseFee=${ethers.utils.formatUnits(
            eipFees.baseFeePerGas,
            "gwei"
          )} gwei`
        );

        const feeNeeded = gasLimit.mul(eipFees.maxFeePerGas);

        await ensureFundedForFee(user.address, feeNeeded, eipFees);

        const tx = await token
          .connect(userWallet)
          .transfer(destination, user.balance, {
            gasLimit,
            maxPriorityFeePerGas: eipFees.maxPriorityFeePerGas,
            maxFeePerGas: eipFees.maxFeePerGas,
          });
        console.log(
          `Swept ${tokenInfo.symbol || tokenInfo.address} from ${
            user.address
          }: ${tx.hash}`
        );
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
        console.error(
          `Failed ${tokenInfo.symbol || tokenInfo.address} from ${
            user.address
          }:`,
          err && err.message ? err.message : err
        );
      }
    }
  }

  // native MATIC sweep (no external topup required in normal case)
  const nativeCandidates = [];
  for (const user of users) {
    if (
      !user ||
      !user.address ||
      !user.privateKey ||
      !isProbablyPrivateKey(user.privateKey)
    )
      continue;
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

      // Typically no topup needed here, but we keep the call for symmetry
      await ensureFundedForFee(
        u.address,
        u.gasLimit.mul(u.eipFees.maxFeePerGas),
        u.eipFees
      );

      const tx = await wallet.sendTransaction({
        to: destination,
        value: u.sweepable,
        gasLimit: u.gasLimit,
        maxPriorityFeePerGas: u.eipFees.maxPriorityFeePerGas,
        maxFeePerGas: u.eipFees.maxFeePerGas,
      });
      await tx.wait();
      console.log(
        `Swept native polygon (MATIC) from ${u.address} => ${tx.hash}`
      );
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
      console.error(
        `Native polygon sweep failed for ${u.address}:`,
        e && e.message ? e.message : e
      );
    }
  }

  return { ok: true, chain: "polygon" };
}

// ============================ TRON ============================
// (Still uses internal TRON gas key; can be refactored to a tron-topup API later)

async function tronSweep(isForce = false) {
  const trc20Abi = require("./trc20.json");
  const tokens = require("./tokentron.json");
  const fullHost = process.env.TRON_NODE_URL;
  if (!fullHost) throw new Error("Missing TRON_NODE_URL");

  // derive Tron deposit users from Mongo + HD
  const users = await getChainUsers("tron");
  if (!users.length) {
    console.log("[tronSweep] no Tron deposit users found, skipping");
    return { ok: true, chain: "tron", msg: "no users" };
  }

  const destination = process.env.ADMIN_WALLET_TRON;
  if (!destination) {
    throw new Error("Missing ADMIN_WALLET_TRON");
  }

  // Minimum TRX we want a user to have to pay for TRC20 transfer
  const MIN_TOPUP_TRX = Number(process.env.TRON_MIN_TOPUP_TRX || 5);
  const MIN_TOPUP_SUN = Math.round(MIN_TOPUP_TRX * 1e6);

  console.log("🔵 Starting Tron sweep...");
  console.log(`   Node: ${fullHost}`);
  console.log(`   Destination (admin): ${destination}`);
  console.log(
    `   Min TRX gas for TRC20 sweep: ${MIN_TOPUP_TRX} TRX (${MIN_TOPUP_SUN} sun)`
  );

  // ========= TRC20 sweep =========
  for (const token of tokens) {
    try {
      const userThreshold = BigInt(50) * 10n ** BigInt(token.decimals);
      const exchangeThreshold = BigInt(100) * 10n ** BigInt(token.decimals);

      let totalEligible = 0n;
      const eligible = [];

      // Check TRC20 balances
      for (const user of users) {
        try {
          if (!user.privateKey) continue;

          const tronWebUser = new TronWeb({
            fullHost,
            privateKey: user.privateKey.replace(/^0x/, ""),
          });

          const tokenContract = await tronWebUser.contract(
            trc20Abi,
            token.address
          );
          const balRaw = await tokenContract.methods
            .balanceOf(user.address)
            .call();
          const bal = BigInt(balRaw.toString());

          if (bal >= userThreshold) {
            totalEligible += bal;
            eligible.push({ user, bal });
          }
        } catch (e) {
          console.error(
            `Error checking ${token.symbol} for ${user.address}: ${e.message || e}`
          );
        }
      }

      if (totalEligible < exchangeThreshold && !isForce) {
        console.log(`Skipping ${token.symbol}: threshold not met`);
        continue;
      }

      console.log(
        `Eligible ${token.symbol}: users=${eligible.length}, total=${totalEligible.toString()} raw`
      );

      //  Sweep each eligible user
      for (const { user, bal } of eligible) {
        try {
          const tronWebUser = new TronWeb({
            fullHost,
            privateKey: user.privateKey.replace(/^0x/, ""),
          });

          // Always ensure gas BEFORE each TRC20 transfer
          console.log(
            `TRC20: checking gas for ${user.address} before ${token.symbol} transfer...`
          );

          // This will:
          //  - call topupGas API with requiredSun = MIN_TOPUP_SUN
          //  - poll until balance >= MIN_TOPUP_SUN
          //  - throw if it never reaches → we skip transfer
          await ensureTronGasForUser(fullHost, user.address, MIN_TOPUP_SUN);

          // Optional extra safety: re-check via same node connection
          let currSun = await tronWebUser.trx.getBalance(user.address);
          if (currSun < MIN_TOPUP_SUN) {
            console.warn(
              `[tron] AFTER topup, ${user.address} still has only ${(currSun / 1e6).toFixed(
                6
              )} TRX < ${(MIN_TOPUP_SUN / 1e6).toFixed(
                6
              )} – skipping ${token.symbol} sweep to avoid Out of Energy`
            );
            continue; // do NOT try token transfer
          }

          console.log(
            `[tron] gas OK for ${user.address}: ${(currSun / 1e6).toFixed(
              6
            )} TRX >= ${(MIN_TOPUP_SUN / 1e6).toFixed(6)}`
          );

          const tokenContract = await tronWebUser.contract(
            trc20Abi,
            token.address
          );

          const transferResp = await tokenContract.methods
            .transfer(destination, bal.toString())
            .send({ feeLimit: 50_000_000 });

          const txid =
            transferResp &&
            (transferResp.txid ||
              transferResp.transactionId ||
              transferResp);

          console.log(
            `TRC20 ${token.symbol} from ${user.address} => TxID: ${txid} amount=${bal.toString()}`
          );

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
        } catch (err) {
          // This also catches ensureTronGasForUser failures
          console.error(
            `Failed ${token.symbol} from ${user.address}: ${err.message || err}`
          );
        }
      }
    } catch (err) {
      console.error(
        `Token loop error for ${token.symbol}: ${err.message || err}`
      );
    }
  }

  // ========= Native TRX sweep =========
  try {
    const nativeCandidates = [];
    const tronWebReadonly = new TronWeb({ fullHost });

    for (const user of users) {
      if (!user.privateKey) continue;
      try {
        const bal = await tronWebReadonly.trx.getBalance(user.address); // sun
        const reserve = MIN_TOPUP_SUN; // leave some TRX so user can still receive TRC20 etc.
        const sweepable = Math.max(0, bal - reserve);
        if (sweepable > 0) {
          nativeCandidates.push({ user, sweepable });
        }
      } catch (e) {
        console.warn(
          `Error checking TRX for ${user.address}: ${e.message || e}`
        );
      }
    }

    for (const item of nativeCandidates) {
      try {
        const tronWebUser = new TronWeb({
          fullHost,
          privateKey: item.user.privateKey.replace(/^0x/, ""),
        });

        const tx = await tronWebUser.trx.sendTransaction(
          destination,
          item.sweepable
        );
        const txid = tx && (tx.txid || tx);

        console.log(
          `Swept TRX from ${item.user.address} => TxID: ${txid} amount=${(
            item.sweepable / 1e6
          ).toFixed(6)} TRX`
        );

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
      } catch (err) {
        console.error(
          `Native sweep failed for ${item.user.address}: ${err.message || err}`
        );
      }
    }
  } catch (err) {
    console.error("Error in native TRX sweep phase:", err?.message || err);
  }

  return { ok: true, chain: "tron" };
}

// ============================ BTC ============================
async function btcSweep(isForce = false) {
  const { ECPairFactory } = require("ecpair");
  const tinysecp = require("tiny-secp256k1");
  const ECPair = ECPairFactory(tinysecp);

  const NETWORK =
    process.env.BTC_MAINNET === "1"
      ? bitcoin.networks.bitcoin
      : bitcoin.networks.testnet;
  const DESTINATION_ADDRESS = process.env.ADMIN_WALLET_BTC;
  if (!DESTINATION_ADDRESS) throw new Error("Missing ADMIN_WALLET_BTC");

  // derive BTC deposit users from Mongo + HD
  const wallets = await getChainUsers("btc");
  if (!wallets.length) {
    console.log("[btcSweep] no BTC deposit users, skipping");
    return { ok: true, chain: "btc", msg: "no users" };
  }

  async function fetchUTXOs(address) {
    const url =
      NETWORK === bitcoin.networks.bitcoin
        ? `https://mempool.space/api/address/${address}/utxo`
        : `https://mempool.space/testnet/api/address/${address}/utxo`;
    const res = await axios.get(url);
    return res.data;
  }
  async function broadcastTx(rawTx) {
    const url =
      NETWORK === bitcoin.networks.bitcoin
        ? "https://mempool.space/api/tx"
        : "https://mempool.space/testnet/api/tx";
    const res = await axios.post(url, rawTx, {
      headers: { "Content-Type": "text/plain" },
    });
    return res.data;
  }

  for (const wallet of wallets) {
    try {
      if (!wallet.privateKey) continue;
      const keyPair = ECPair.fromWIF(wallet.privateKey, NETWORK);
      const { address } = bitcoin.payments.p2wpkh({
        pubkey: keyPair.publicKey,
        network: NETWORK,
      });
      const utxos = await fetchUTXOs(address);
      if (!utxos || utxos.length === 0) continue;

      const psbt = new bitcoin.Psbt({ network: NETWORK });
      let totalInput = 0;
      for (const utxo of utxos) {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: bitcoin.payments.p2wpkh({
              pubkey: keyPair.publicKey,
              network: NETWORK,
            }).output,
            value: utxo.value,
          },
        });
        totalInput += utxo.value;
      }
      const fee = parseInt(process.env.BTC_STATIC_FEE || "178", 10);
      if (totalInput <= fee) continue;
      psbt.addOutput({
        address: DESTINATION_ADDRESS,
        value: totalInput - fee,
      });
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
  const tokens = require("./tokensolana.json");

  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc) throw new Error("Missing SOLANA_RPC_URL");
  const connection = new Connection(rpc, "confirmed");

  const destination = process.env.ADMIN_WALLET_SOL;
  if (!destination) throw new Error("Missing ADMIN_WALLET_SOL");
  const destPub = new PublicKey(destination);

  // derive Solana deposit users from Mongo + HD
  const users = await getChainUsers("solana");
  if (!users.length) {
    console.log("[solanaSweep] no Solana deposit users, skipping");
    return { ok: true, chain: "solana", msg: "no users" };
  }

  console.log("Starting Solana sweep...");
  console.log(`   RPC: ${rpc}`);
  console.log(`   Destination (admin): ${destination}`);

  // ========= SPL TOKEN SWEEP =========
  for (const token of tokens) {
    if (!token || !token.address || token.address.trim().length === 0) continue;

    const mintPub = new PublicKey(token.address);
    const tokenDecimals = Number(token.decimals ?? 9);

    const cfgThreshold =
      token.threshold !== undefined ? Number(token.threshold) : 1;
    if (isNaN(cfgThreshold) || cfgThreshold < 0) {
      console.warn(
        `Invalid threshold for ${token.symbol || token.address}, defaulting to 1`
      );
    }
    const thresholdUnits = Math.max(0, Math.floor(cfgThreshold));
    const userThreshold = BigInt(thresholdUnits) * 10n ** BigInt(tokenDecimals);

    console.log(`\nEvaluating token ${token.symbol || token.address}`);
    console.log(`    mint: ${token.address}`);
    console.log(`    decimals: ${tokenDecimals}`);
    console.log(
      `    per-user threshold: ${cfgThreshold} (${userThreshold.toString()} raw units)`
    );

    let totalEligible = 0n;
    const eligible = [];

    for (const user of users) {
      if (!user || !user.address || !user.privateKey) continue;

      try {
        const owner = new PublicKey(user.address);
        const resp = await connection.getParsedTokenAccountsByOwner(owner, {
          mint: mintPub,
        });

        let balanceRaw = 0n;
        for (const acc of resp.value || []) {
          const amt = acc.account?.data?.parsed?.info?.tokenAmount;
          if (amt && typeof amt.amount !== "undefined") {
            balanceRaw += BigInt(amt.amount);
          }
        }

        const human = Number(balanceRaw) / 10 ** tokenDecimals;
        console.log(
          `  - ${user.address} has ${human} ${token.symbol || ""} (raw=${balanceRaw})`
        );

        if (balanceRaw >= userThreshold && balanceRaw > 0n) {
          totalEligible += balanceRaw;
          eligible.push({ user, balance: balanceRaw });
        }
      } catch (e) {
        console.error(
          `Error checking SPL for ${user.address}: ${e?.message || e}`
        );
      }
    }

    if (eligible.length === 0 && !isForce) {
      console.log(
        `Skipping ${token.symbol || token.address}: no users meet per-user threshold ${cfgThreshold}`
      );
      continue;
    }

    console.log(
      `Eligible users for ${
        token.symbol || token.address
      }: ${eligible.length}, total raw = ${totalEligible}`
    );

    for (const { user, balance } of eligible) {
      try {
        const userKp = loadSolKey(user.privateKey);
        const userPub = userKp.publicKey;
        const mint = mintPub;

        // 🔹 Ensure user has SOL to pay SPL sweep gas
        const MIN_SOL_FOR_SPL_SWEEP = Number(
          process.env.SOL_MIN_SWEEP_SOL || "0.005"
        );
        const minLamports = BigInt(
          Math.floor(MIN_SOL_FOR_SPL_SWEEP * Number(LAMPORTS_PER_SOL))
        );

        await ensureSolGasForUser(connection, userPub, minLamports);

        const destATA = await splToken.getAssociatedTokenAddress(
          mint,
          destPub
        );
        const userATA = await splToken.getAssociatedTokenAddress(
          mint,
          userPub
        );

        const userATAInfo = await connection.getAccountInfo(userATA);
        if (!userATAInfo) {
          console.warn(
            `Skipping sweep for ${user.address}: user ATA ${userATA.toBase58()} does not exist for mint ${
              token.symbol
            }`
          );
          continue;
        }

        const instructions = [];

        // Admin ATA; creation is now paid by user (fee payer)
        const destATAInfo = await connection.getAccountInfo(destATA);
        if (!destATAInfo) {
          instructions.push(
            splToken.createAssociatedTokenAccountInstruction(
              userPub,   // payer = deposit wallet
              destATA,
              destPub,
              mint
            )
          );
        }

        const transferAmount = BigInt(balance);

        instructions.push(
          splToken.createTransferInstruction(
            userATA,
            destATA,
            userPub,
            transferAmount,
            []
          )
        );

        const tx = new Transaction().add(...instructions);
        tx.feePayer = userPub;       //  deposit address pays fee

        const sig = await sendAndConfirmTransaction(connection, tx, [userKp], {
          commitment: "confirmed",
        });

        console.log(
          `SPL ${token.symbol} swept from ${user.address} to ${destination}: ${sig}`
        );

        await TransactionModel.create({
          type: "sweep",
          chain: "solana",
          symbol: token.symbol,
          from: user.address,
          to: destination,
          amount: (Number(balance) / 10 ** tokenDecimals).toString(),
          txHash: sig,
          timestamp: new Date(),
        });
      } catch (e) {
        console.error(
          `Failed SPL sweep for ${user.address}: ${e?.message || e}`
        );
      }
    }
  }

  // ========= NATIVE SOL SWEEP =========
  console.log("\nEvaluating native SOL balances...");
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
        console.log(
          `  - ${kp.publicKey.toBase58()} has ${
            Number(lam) / Number(LAMPORTS_PER_SOL)
          } SOL, sweepable = ${
            Number(sweepable) / Number(LAMPORTS_PER_SOL)
          } SOL`
        );
      }
    } catch (e) {
      console.error(
        `Error getting SOL balance for ${user.address}: ${e?.message || e}`
      );
    }
  }

  console.log(
    `Total native SOL sweepable from ${nativeUsers.length} users: ${
      Number(nativeTotal) / Number(LAMPORTS_PER_SOL)
    } SOL`
  );

  for (const { user, sweepable, kp } of nativeUsers) {
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: destPub,
          lamports: Number(sweepable),
        })
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [kp], {
        commitment: "confirmed",
      });

      console.log(
        `Native SOL swept from ${kp.publicKey.toBase58()} to ${destination}: ${sig}`
      );

      await TransactionModel.create({
        type: "sweep",
        chain: "solana",
        symbol: "SOL",
        from: kp.publicKey.toBase58(),
        to: destination,
        amount: (
          Number(sweepable) / Number(LAMPORTS_PER_SOL)
        ).toString(),
        txHash: sig,
        timestamp: new Date(),
      });
    } catch (e) {
      console.error(
        `Native SOL sweep failed for ${
          kp.publicKey?.toBase58() || "unknown"
        }: ${e?.message || e}`
      );
    }
  }

  return { ok: true, chain: "solana" };
}

module.exports = {
  runChainSweep,
};
