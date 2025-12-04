// monitorDeposit.js
require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const Web3 = require("web3");
const { ethers } = require("ethers");
const TronWeb = require("tronweb");
const mongoose = require("mongoose");

const Transaction = require("./src/models/transactionmodels");
const UserBalance = require("./src/models/userBalancemodels");
const Address = require("./src/models/Wallets");

// === MongoDB Setup ===
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/", {
  // useNewUrlParser: true,
  // useUnifiedTopology: true,
});

// === In-memory dedupe ===
const recentTxs = new Set(); // for tx hashes / signatures
const RECENT_TX_TTL_MS = Number(process.env.RECENT_TX_TTL_MS || 5 * 60 * 1000);

// === Deposit addresses (dynamically loaded from Mongo) ===
let ethAddresses = [];
let bscAddresses = [];
let polygonAddresses = [];
let tronAddresses = [];
let btcAddresses = [];
let solAddresses = [];

/**
 * Small helper to validate Solana public keys
 */
const { Connection, PublicKey, clusterApiUrl } = require("@solana/web3.js");
function isValidSolanaPubkey(str) {
  try {
    new PublicKey(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reload all deposit addresses from Mongo Address collection.
 * We assume Address docs are created by /api/onboarding/create-wallet
 * with fields: userId, chain, address, index, path
 */
async function reloadDepositAddresses() {
  const addrs = await Address.find({}).lean();

  ethAddresses = addrs
    .filter((a) => a.chain === "ethereum")
    .map((a) => a.address.toLowerCase());

  bscAddresses = addrs
    .filter((a) => a.chain === "bsc")
    .map((a) => a.address.toLowerCase());

  polygonAddresses = addrs
    .filter((a) => a.chain === "polygon")
    .map((a) => a.address.toLowerCase());

 tronAddresses = addrs
  .filter((a) => a.chain === "tron" && a.address)
  .map((a) => String(a.address).trim().toLowerCase());

  btcAddresses = addrs
    .filter((a) => a.chain === "btc" || a.chain === "bitcoin")
    .map((a) => a.address);

  // Only keep valid Solana base58 addresses
  solAddresses = [];
  for (const a of addrs.filter((a) => a.chain === "solana")) {
    if (!a.address) continue;
    if (!isValidSolanaPubkey(a.address)) {
      console.warn("Skipping invalid Solana address in DB:", a.address);
      continue;
    }
    solAddresses.push(a.address);
  }

  console.log("Reloaded deposit addresses from Mongo:");
  console.log(
    "ETH:", ethAddresses.length,
    "BSC:", bscAddresses.length,
    "POL:", polygonAddresses.length,
    "TRON:", tronAddresses.length,
    "BTC:", btcAddresses.length,
    "SOL:", solAddresses.length,
  );
}

// === Load Tokens / ABIs ===
const erc20Abi = JSON.parse(fs.readFileSync("./erc20.json"));
const trc20Abi = JSON.parse(fs.readFileSync("./trc20.json"));
const tokensEth = JSON.parse(fs.readFileSync("./tokenethereum.json"));
const tokensBsc = JSON.parse(fs.readFileSync("./tokenbsc.json"));
const tokensTron = JSON.parse(fs.readFileSync("./tokentron.json"));
const tokensPolygon = JSON.parse(fs.readFileSync("./tokenpolygon.json"));
const tokensSol = JSON.parse(
  fs.readFileSync("./tokensolana.json", "utf8") || "[]"
);

// === Providers ===
const ethProvider = new ethers.providers.JsonRpcProvider(
  process.env.ETH_NODE_URL
);
const tronWeb = new TronWeb({
  fullHost: process.env.TRON_NODE_URL,
});
tronWeb.setEventServer("https://api.shasta.trongrid.io");

// Simple timeout helper used for Solana RPC
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("rpc timeout")), ms)
    ),
  ]);
}

/* ------------------------------------------------------------------
   ETH NATIVE
-------------------------------------------------------------------*/
async function monitorETHNative() {
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.ETH_NODE_URL
  );
  let lastBlock = await provider.getBlockNumber();

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();

      for (let i = lastBlock + 1; i <= currentBlock; i++) {
        const block = await provider.getBlockWithTransactions(i);
        if (!block || !Array.isArray(block.transactions)) continue;

        for (const tx of block.transactions) {
          if (tx.to && ethAddresses.includes(tx.to.toLowerCase())) {
            const amount = parseFloat(ethers.utils.formatEther(tx.value));

            console.log(
              `Native ETH received: ${amount} ETH from ${tx.from} to ${tx.to}`
            );

            await Transaction.create({
              chain: "ethereum",
              type: "deposit",
              symbol: "ETH",
              from: tx.from,
              to: tx.to,
              amount,
              txHash: tx.hash,
            });

            // CREDIT DEPOSIT ADDRESS (to), not sender
            await UserBalance.findOneAndUpdate(
              { address: tx.to.toLowerCase(), chain: "ethereum", symbol: "ETH" },
              { $inc: { balance: amount } },
              { upsert: true, new: true }
            );
          }
        }
      }

      lastBlock = currentBlock;
    } catch (err) {
      console.error(" Error in monitorETHNative:", err);
    }
  }, 15_000);
}

/* ------------------------------------------------------------------
   BNB NATIVE (BSC)
-------------------------------------------------------------------*/
async function monitorBNBNative() {
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.BSC_NODE_URL
  );
  let lastBlock = await provider.getBlockNumber();

  console.log("BNB native monitor starting at block", lastBlock);

  const POLL_MS = Number(process.env.BSC_POLL_MS || 15_000);

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();

      if (currentBlock <= lastBlock) return;

      for (let i = lastBlock + 1; i <= currentBlock; i++) {
        let block;
        try {
          block = await provider.getBlockWithTransactions(i);
        } catch (e) {
          console.warn(
            `Failed to fetch BSC block ${i}:`,
            e.message || e
          );
          break;
        }

        if (!block || !Array.isArray(block.transactions)) continue;

        for (const tx of block.transactions) {
          try {
            if (!tx || !tx.to) continue;
            const toLower = tx.to.toLowerCase();
            if (!bscAddresses.includes(toLower)) continue;

            if (recentTxs.has(tx.hash)) continue;

            const already = await Transaction.findOne({
              chain: "bsc",
              txHash: tx.hash,
            }).lean();
            if (already) {
              recentTxs.add(tx.hash);
              setTimeout(
                () => recentTxs.delete(tx.hash),
                RECENT_TX_TTL_MS
              );
              continue;
            }

            const amount = parseFloat(ethers.utils.formatEther(tx.value));
            console.log(
              `Native BNB received: ${amount} BNB from ${tx.from} to ${tx.to}`
            );

            await Transaction.create({
              chain: "bsc",
              type: "deposit",
              symbol: "BNB",
              from: tx.from,
              to: tx.to,
              amount,
              txHash: tx.hash,
            });

            await UserBalance.findOneAndUpdate(
              { address: toLower, chain: "bsc", symbol: "BNB" },
              { $inc: { balance: amount } },
              { upsert: true, new: true }
            );

            recentTxs.add(tx.hash);
            setTimeout(() => recentTxs.delete(tx.hash), RECENT_TX_TTL_MS);
          } catch (innerErr) {
            console.error(
              "Error processing BNB tx:",
              innerErr?.message || innerErr
            );
          }
        }
      }

      lastBlock = currentBlock;
    } catch (err) {
      console.error(" Error in monitorBNBNative:", err?.message || err);
    }
  }, POLL_MS);
}

/* ------------------------------------------------------------------
   POLYGON NATIVE (MATIC)
-------------------------------------------------------------------*/
async function monitorPolygonNative() {
  if (!polygonAddresses.length) {
    console.log(
      "No Polygon addresses configured for native monitor. Skipping Polygon native monitor."
    );
    return;
  }

  const provider = new ethers.providers.JsonRpcProvider(
    process.env.POLYGON_NODE_URL
  );
  let lastBlock = await provider.getBlockNumber();
  console.log("Polygon native monitor starting at block", lastBlock);

  const POLL_MS = Number(process.env.POLYGON_POLL_MS || 15_000);

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();

      if (currentBlock <= lastBlock) return;

      for (let i = lastBlock + 1; i <= currentBlock; i++) {
        let block;
        try {
          block = await provider.getBlockWithTransactions(i);
        } catch (e) {
          console.warn(
            `Failed to fetch Polygon block ${i}:`,
            e?.message || e
          );
          break;
        }
        if (!block || !Array.isArray(block.transactions)) continue;

        for (const tx of block.transactions) {
          try {
            if (!tx || !tx.to) continue;
            const toLower = tx.to.toLowerCase();
            if (!polygonAddresses.includes(toLower)) continue;

            if (recentTxs.has(tx.hash)) continue;

            const exists = await Transaction.findOne({
              chain: "polygon",
              txHash: tx.hash,
            }).lean();
            if (exists) {
              recentTxs.add(tx.hash);
              setTimeout(
                () => recentTxs.delete(tx.hash),
                RECENT_TX_TTL_MS
              );
              continue;
            }

            const amount = parseFloat(ethers.utils.formatEther(tx.value));
            console.log(
              `Native MATIC received: ${amount} MATIC from ${tx.from} to ${tx.to} (tx ${tx.hash})`
            );

            await Transaction.create({
              chain: "polygon",
              type: "deposit",
              symbol: "MATIC",
              from: tx.from,
              to: tx.to,
              amount,
              txHash: tx.hash,
            });

            // CREDIT DEPOSIT ADDRESS
            await UserBalance.findOneAndUpdate(
              { address: toLower, chain: "polygon", symbol: "MATIC" },
              { $inc: { balance: amount } },
              { upsert: true, new: true }
            );

            recentTxs.add(tx.hash);
            setTimeout(() => recentTxs.delete(tx.hash), RECENT_TX_TTL_MS);
          } catch (inner) {
            console.warn(
              "Error processing Polygon native tx:",
              inner?.message || inner
            );
          }
        }
      }

      lastBlock = currentBlock;
    } catch (err) {
      console.error("Error in monitorPolygonNative:", err?.message || err);
    }
  }, POLL_MS);
}

/* ------------------------------------------------------------------
   TRX NATIVE
-------------------------------------------------------------------*/
async function monitorTRXNative() {
  let lastBlockNum;
  try {
    const currentBlock = await tronWeb.trx.getCurrentBlock();
    lastBlockNum = currentBlock.block_header.raw_data.number;
  } catch (e) {
    console.warn(
      "Could not read current TRON block on startup:",
      e.message || e
    );
    lastBlockNum = 0;
  }

  console.log("TRX native monitor starting at block", lastBlockNum);

  async function saveTrxIfNew({ txId, fromAddr, toAddr, amount }) {
    if (!txId) return false;
    if (recentTxs.has(txId)) return false;

    const exists = await Transaction.findOne({
      chain: "tron",
      txHash: txId,
    }).lean();
    if (exists) {
      recentTxs.add(txId);
      setTimeout(() => recentTxs.delete(txId), RECENT_TX_TTL_MS);
      return false;
    }

    try {
      await Transaction.create({
        chain: "tron",
        type: "deposit",
        symbol: "TRX",
        from: fromAddr,
        to: toAddr,
        amount,
        txHash: txId,
        timestamp: new Date(),
      });

      await UserBalance.findOneAndUpdate(
        { address: toAddr, chain: "tron", symbol: "TRX" },
        { $inc: { balance: amount } },
        { upsert: true, new: true }
      );

      recentTxs.add(txId);
      setTimeout(() => recentTxs.delete(txId), RECENT_TX_TTL_MS);
      return true;
    } catch (e) {
      if (e && e.code === 11000) {
        recentTxs.add(txId);
        setTimeout(() => recentTxs.delete(txId), RECENT_TX_TTL_MS);
        return false;
      }
      throw e;
    }
  }

  const POLL_MS = Number(process.env.TRON_POLL_MS || 15_000);

  setInterval(async () => {
    try {
      const currentBlockObj = await tronWeb.trx.getCurrentBlock();
      const currentBlockNum = currentBlockObj.block_header.raw_data.number;

      if (currentBlockNum <= lastBlockNum) return;

      for (let b = lastBlockNum + 1; b <= currentBlockNum; b++) {
        try {
          const block = await tronWeb.trx.getBlock(b);
          if (!block || !Array.isArray(block.transactions)) continue;

          for (const tx of block.transactions || []) {
            try {
              const txId =
                tx.txID ||
                tx.txid ||
                (tx.raw_data && tx.raw_data.txID) ||
                null;
              if (!txId) continue;
              if (recentTxs.has(txId)) continue;

              let txRaw = null;
              try {
                txRaw =
                  tx.raw_data &&
                  tx.raw_data.contract &&
                  tx.raw_data.contract[0] &&
                  tx.raw_data.contract[0].parameter &&
                  tx.raw_data.contract[0].parameter.value;
              } catch (e) {}
              if (!txRaw) continue;
              if (!txRaw.to_address || !txRaw.owner_address) {
      // not a simple TransferContract, skip
      continue;
    }

              const toAddrBase58 = tronWeb.address.fromHex(txRaw.to_address);
              const fromAddrBase58 = tronWeb.address.fromHex(txRaw.owner_address);
              const toAddr = toAddrBase58.toLowerCase();
              const fromAddr = fromAddrBase58.toLowerCase();
              const amount = (txRaw.amount || 0) / 1e6;

            if (!tronAddresses.includes(toAddr)) continue;

            await saveTrxIfNew({ txId, fromAddr, toAddr, amount });

              if (recentTxs.has(txId)) {
                console.log(
                  `Native TRX received: ${amount} TRX from ${fromAddr} to ${toAddr} (tx ${txId})`
                );
              }
            } catch (inner) {
              console.warn(
                "Error processing TRX tx inside block:",
                inner?.message || inner
              );
            }
          }

          lastBlockNum = b;
        } catch (blkErr) {
          console.warn(
            `Failed to fetch/process TRON block ${b}:`,
            blkErr?.message || blkErr
          );
          break;
        }
      }
    } catch (err) {
      console.error("Error in monitorTRXNative:", err?.message || err);
    }
  }, POLL_MS);
}

/* ------------------------------------------------------------------
   ETH ERC-20 TOKENS
-------------------------------------------------------------------*/
async function monitorETH() {
  for (const token of tokensEth) {
    const contract = new ethers.Contract(
      token.address,
      erc20Abi,
      ethProvider
    );
    contract.on("Transfer", async (from, to, value, event) => {
      try {
        if (!to) return;
        const toLower = to.toLowerCase();
        if (!ethAddresses.includes(toLower)) return;

        const amount = ethers.utils.formatUnits(value, token.decimals);
        console.log(
          `ETH: ${token.symbol} ${amount} from ${from} to ${to}`
        );

        await Transaction.create({
          type: "deposit",
          chain: "ethereum",
          symbol: token.symbol,
          from,
          to,
          amount,
          txHash: event.transactionHash,
        });

        // CREDIT DEPOSIT ADDRESS
        await UserBalance.findOneAndUpdate(
          {
            address: toLower,
            chain: "ethereum",
            symbol: token.symbol,
          },
          { $inc: { balance: parseFloat(amount) } },
          { upsert: true, new: true }
        );
      } catch (e) {
        console.error("Error in ETH token monitor:", e?.message || e);
      }
    });
  }
}

/* ------------------------------------------------------------------
   BSC ERC-20 TOKENS (via polling)
-------------------------------------------------------------------*/
async function monitorBSC() {
  const httpProvider = process.env.BSC_NODE_URL;
  if (!httpProvider) {
    console.error(
      "BSC_NODE_URL (HTTP) is required for polling-based monitor"
    );
    return;
  }
  const web3http = new Web3(httpProvider);

  const lastProcessed = {};
  const POLL_MS = Number(process.env.BSC_POLL_MS || 15_000);

  async function pollOnce() {
    try {
      const latest = await web3http.eth.getBlockNumber();

      for (const token of tokensBsc) {
        try {
          const contract = new web3http.eth.Contract(erc20Abi, token.address);
          const key = token.address.toLowerCase();
          const fromBlock = Math.max(
            lastProcessed[key] || latest - 10,
            0
          );
          const toBlock = latest;

          const events = await contract.getPastEvents("Transfer", {
            fromBlock,
            toBlock,
          });

          if (!events || events.length === 0) {
            lastProcessed[key] = toBlock;
            continue;
          }

          for (const e of events) {
            try {
              if (!e.returnValues) continue;
              const { from, to, value } = e.returnValues;
              if (!to) continue;

              const toLower = to.toLowerCase();
              if (!bscAddresses.includes(toLower)) continue;

              const amount =
                parseFloat(value) / (10 ** token.decimals || 18);
              console.log(
                `BSC: ${token.symbol} ${amount} from ${from} to ${to}`
              );

              await Transaction.create({
                type: "deposit",
                chain: "bsc",
                symbol: token.symbol,
                from,
                to,
                amount,
                txHash: e.transactionHash,
              });

              // CREDIT DEPOSIT ADDRESS
              await UserBalance.findOneAndUpdate(
                {
                  address: toLower,
                  chain: "bsc",
                  symbol: token.symbol,
                },
                { $inc: { balance: parseFloat(amount) } },
                { upsert: true, new: true }
              );
            } catch (innerErr) {
              console.warn(
                "error processing single BSC event:",
                innerErr?.message || innerErr
              );
            }
          }

          lastProcessed[key] = toBlock;
        } catch (errToken) {
          console.warn(
            "BSC token poll error for",
            token.address,
            errToken?.message || errToken
          );
        }
      }
    } catch (err) {
      console.error("BSC poll failed:", err?.message || err);
    }
  }

  await pollOnce();
  setInterval(pollOnce, POLL_MS);
}

/* ------------------------------------------------------------------
   POLYGON ERC-20 TOKENS
-------------------------------------------------------------------*/
async function monitorPOLY() {
  if (!tokensPolygon || tokensPolygon.length === 0) {
    console.log(
      "No Polygon tokens configured (tokenpolygon.json). Skipping Polygon token monitor."
    );
    return;
  }

  console.log("Polygon token monitor starting...");
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.POLYGON_NODE_URL
  );

  for (const token of tokensPolygon) {
    try {
      if (!token || !token.address) continue;
      const contract = new ethers.Contract(
        token.address,
        erc20Abi,
        provider
      );
      console.log(
        `Watching POLYGON token: ${
          token.symbol || token.address
        } at ${token.address}`
      );

      contract.on("Transfer", async (from, to, value, event) => {
        try {
          if (!to) return;
          const toLower = String(to).toLowerCase();
          if (!polygonAddresses.includes(toLower)) return;

          if (recentTxs.has(event.transactionHash)) return;

          const already = await Transaction.findOne({
            chain: "polygon",
            txHash: event.transactionHash,
          }).lean();
          if (already) {
            recentTxs.add(event.transactionHash);
            setTimeout(
              () => recentTxs.delete(event.transactionHash),
              RECENT_TX_TTL_MS
            );
            return;
          }

          const amountStr = ethers.utils.formatUnits(
            value,
            token.decimals || 18
          );
          const amount = parseFloat(amountStr);

          console.log(
            `POLYGON: ${token.symbol} ${amountStr} from ${from} to ${to} (tx ${event.transactionHash})`
          );

          await Transaction.create({
            type: "deposit",
            chain: "polygon",
            symbol: token.symbol || token.address,
            from,
            to,
            amount,
            txHash: event.transactionHash,
          });

          //  CREDIT DEPOSIT ADDRESS
          await UserBalance.findOneAndUpdate(
            {
              address: toLower,
              chain: "polygon",
              symbol: token.symbol || token.address,
            },
            { $inc: { balance: amount } },
            { upsert: true, new: true }
          );

          recentTxs.add(event.transactionHash);
          setTimeout(
            () => recentTxs.delete(event.transactionHash),
            RECENT_TX_TTL_MS
          );
        } catch (e) {
          console.error(
            "Error in Polygon token event handler:",
            e?.message || e
          );
        }
      });
    } catch (e) {
      console.warn(
        "Failed to attach Polygon token listener:",
        token?.address,
        e?.message || e
      );
    }
  }
}

  // TRON TRC-20 TOKENS

async function monitorTRON() {
  try {
    for (const token of tokensTron) {
      const contract = await tronWeb.contract(trc20Abi, token.address);
      console.log(
        `Watching TRON token: ${token.symbol} at ${token.address}`
      );

      contract.Transfer().watch(async (err, event) => {
        try {
          if (err) {
            console.error(`Watch error for ${token.symbol}:`, err);
            return;
          }

          if (!event?.result) return;

          const { from, to, value } = event.result;

          const toBase58   = tronWeb.address.fromHex(to);
          const fromBase58 = tronWeb.address.fromHex(from);

          // normalize like TRX native
          const toAddr   = toBase58.toLowerCase();
          const fromAddr = fromBase58.toLowerCase();

          // Log all events for debugging
          console.log(
            `Event: ${token.symbol} ${value} from ${fromBase58} to ${toBase58}`
          );

          // Only care if it's to our (lowercased) deposit addresses
          if (!tronAddresses.includes(toAddr)) {
            // console.log("Not our TRON deposit address, ignoring");
            return;
          }

          // Amount in human units
          const amount = Number(value) / 10 ** token.decimals;

          console.log(
            `TRON DEPOSIT: ${amount} ${token.symbol} → ${toAddr}`
          );

          // Store transaction
          await Transaction.create({
            type: "deposit",
            chain: "tron",
            symbol: token.symbol,
            from: fromAddr,
            to: toAddr,
            amount,
            txHash: event.transaction,
          });

          // Update user balance (note: using toAddr, not toBase58)
          const ub = await UserBalance.findOneAndUpdate(
            {
              address: toAddr,
              chain: "tron",
              symbol: token.symbol,
            },
            { $inc: { balance: amount } },
            { upsert: true, new: true }
          );

          //console.log(" TRON UserBalance upsert:", ub);
        } catch (e) {
          console.error("Error in TRON event handler:", e);
        }
      });
    }
  } catch (e) {
    console.error(" Error in monitorTRON:", e);
  }
}

/* ------------------------------------------------------------------
   BTC NATIVE (TESTNET via Blockstream)
-------------------------------------------------------------------*/
async function monitorBTCNative() {
  console.log("BTC Monitor started (Testnet)");
  const BTC_POLL_MS = Number(process.env.BTC_POLL_MS || 30_000);
  const axiosInstance = axios.create({ timeout: 20_000 });

  const addressBackoff = {};
  const lastSeenTxId = {};

  for (const address of btcAddresses) {
    try {
      const latest = await Transaction.findOne({
        chain: "bitcoin",
        to: address,
      })
        .sort({ timestamp: -1 })
        .lean();
      if (latest && latest.txHash) lastSeenTxId[address] = latest.txHash;
      else lastSeenTxId[address] = null;
    } catch (e) {
      console.warn(
        "Could not init lastSeen for",
        address,
        e.message || e
      );
      lastSeenTxId[address] = null;
    }
  }

  async function saveBtcDepositIfNew({ address, txId, amount, from }) {
    if (!txId) return false;
    if (recentTxs.has(txId)) return false;

    const already = await Transaction.findOne({
      chain: "bitcoin",
      txHash: txId,
    }).lean();
    if (already) {
      recentTxs.add(txId);
      setTimeout(() => recentTxs.delete(txId), RECENT_TX_TTL_MS);
      return false;
    }

    try {
      await Transaction.create({
        chain: "bitcoin",
        type: "deposit",
        symbol: "BTC",
        from: from || "unknown",
        to: address,
        amount,
        txHash: txId,
        timestamp: new Date(),
      });

      await UserBalance.findOneAndUpdate(
        { address: address, chain: "bitcoin", symbol: "BTC" },
        { $inc: { balance: amount } },
        { upsert: true, new: true }
      );

      recentTxs.add(txId);
      setTimeout(() => recentTxs.delete(txId), RECENT_TX_TTL_MS);
      return true;
    } catch (e) {
      if (e && e.code === 11000) {
        recentTxs.add(txId);
        setTimeout(() => recentTxs.delete(txId), RECENT_TX_TTL_MS);
        return false;
      }
      throw e;
    }
  }

  setInterval(async () => {
    for (const address of btcAddresses) {
      try {
        if (
          addressBackoff[address] &&
          Date.now() < addressBackoff[address]
        ) {
          continue;
        }

        const url = `https://blockstream.info/testnet/api/address/${address}/txs`;
        const res = await axiosInstance.get(url);
        const txs = Array.isArray(res.data) ? res.data : [];

        if (!txs.length) continue;

        const lastSeen = lastSeenTxId[address];
        const unseen = [];
        for (const t of txs) {
          if (!t || !t.txid) continue;
          if (lastSeen && t.txid === lastSeen) break;
          unseen.push(t);
        }

        unseen.reverse();

        for (const t of unseen) {
          try {
            const txId = t.txid;
            if (recentTxs.has(txId)) continue;

            for (const vout of t.vout || []) {
              if (vout.scriptpubkey_address === address) {
                const amount = (vout.value || 0) / 1e8;
                const from =
                  t.vin?.[0]?.prevout?.scriptpubkey_address ||
                  "unknown";

                await saveBtcDepositIfNew({ address, txId, amount, from });
                break;
              }
            }

            lastSeenTxId[address] = txId;
          } catch (inner) {
            console.warn(
              "Error processing BTC tx:",
              inner?.message || inner
            );
          }
        }

        if (txs.length > 0) lastSeenTxId[address] = txs[0].txid;
      } catch (err) {
        console.error(
          ` Error checking BTC for address ${address}:`,
          err?.response?.status || err.message
        );
        if (err?.response?.status === 429) {
          addressBackoff[address] =
            Date.now() +
            (Number(process.env.BTC_BACKOFF_MS) || 60_000);
          console.warn(
            `429 for ${address} — backing off for 60s`
          );
        } else {
          addressBackoff[address] = Date.now() + 5_000;
        }
      }
    }
  }, BTC_POLL_MS);
}

/* ------------------------------------------------------------------
   SOLANA NATIVE + SPL TOKENS
-------------------------------------------------------------------*/
let solanaConnection;

async function pickWorkingSolanaRpc(candidates, timeout = 8000) {
  for (const url of candidates) {
    try {
      const conn = new Connection(url, { commitment: "finalized" });
      const ver = await withTimeout(conn.getVersion(), timeout);
      console.log(
        "Using Solana RPC:",
        url,
        "version:",
        ver?.solanaCore || JSON.stringify(ver)
      );
      return conn;
    } catch (e) {
      console.warn("RPC candidate failed:", url, e?.message || e);
    }
  }
  throw new Error("No working Solana RPC found from candidates");
}

const RPC_CANDIDATES = [
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  "https://rpc.ankr.com/solana_devnet",
];

function lamportsToSol(lamports) {
  return Number(lamports) / 1e9;
}

// Native SOL monitor
async function monitorSolNative() {
  if (!solAddresses.length) {
    console.log(
      "No Solana addresses in Address collection. Skipping SOL native monitor."
    );
    return;
  }

  console.log("Solana native monitor starting...");
  const lastSeenSig = {};

  for (const addr of solAddresses) {
    try {
      const latest = await Transaction.findOne({
        chain: "solana",
        to: addr,
      })
        .sort({ timestamp: -1 })
        .lean();
      lastSeenSig[addr] = latest?.txHash || null;
    } catch (e) {
      lastSeenSig[addr] = null;
    }
  }

  const POLL_MS = Number(process.env.SOL_POLL_MS || 15_000);

  setInterval(async () => {
    for (const addr of solAddresses) {
      try {
        const pubkey = new PublicKey(addr);
        const sigInfos = await solanaConnection.getSignaturesForAddress(
          pubkey,
          { limit: 20 }
        );

        if (!Array.isArray(sigInfos) || sigInfos.length === 0) continue;

        const sigs = [];
        for (const s of sigInfos) {
          if (lastSeenSig[addr] && s.signature === lastSeenSig[addr])
            break;
          sigs.push(s.signature);
        }
        if (!sigs.length) continue;

        sigs.reverse();

        for (const sig of sigs) {
          try {
            if (recentTxs.has(sig)) continue;

            const already = await Transaction.findOne({
              chain: "solana",
              txHash: sig,
            }).lean();
            if (already) {
              recentTxs.add(sig);
              setTimeout(
                () => recentTxs.delete(sig),
                RECENT_TX_TTL_MS
              );
              continue;
            }

            const txResp = await solanaConnection.getTransaction(sig, {
              commitment: "confirmed",
            });
            if (!txResp) continue;

            const accountIndex =
              txResp.transaction.message.accountKeys.findIndex(
                (k) => String(k) === addr
              );
            let solReceived = 0;

            if (
              accountIndex >= 0 &&
              Array.isArray(txResp.meta?.preBalances) &&
              Array.isArray(txResp.meta?.postBalances)
            ) {
              const pre = txResp.meta.preBalances[accountIndex] || 0;
              const post =
                txResp.meta.postBalances[accountIndex] || 0;
              const diff = post - pre;
              if (diff > 0) solReceived = lamportsToSol(diff);
            }

            if (solReceived > 0) {
              console.log(
                `SOL: Received ${solReceived} SOL to ${addr} (tx ${sig})`
              );

              await Transaction.create({
                type: "deposit",
                chain: "solana",
                symbol: "SOL",
                from:
                  txResp.transaction.message.accountKeys[0]
                    ? String(
                        txResp.transaction.message.accountKeys[0]
                      )
                    : "unknown",
                to: addr,
                amount: solReceived,
                txHash: sig,
                timestamp: new Date(
                  txResp.blockTime
                    ? txResp.blockTime * 1000
                    : Date.now()
                ),
              });

              await UserBalance.findOneAndUpdate(
                { address: addr, chain: "solana", symbol: "SOL" },
                { $inc: { balance: solReceived } },
                { upsert: true, new: true }
              );
            }

            recentTxs.add(sig);
            setTimeout(() => recentTxs.delete(sig), RECENT_TX_TTL_MS);
          } catch (inner) {
            console.warn(
              "Error processing SOL signature:",
              inner?.message || inner
            );
          }
        }

        lastSeenSig[addr] =
          sigInfos[0]?.signature || lastSeenSig[addr];
      } catch (e) {
        console.warn(
          "Error polling Solana for address",
          addr,
          e?.message || e
        );
      }
    }
  }, POLL_MS);
}

// SPL monitor (credit deposit address, not sender)
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } =
  require("@solana/spl-token");

// SPL monitor based on wallet owner (no tokenAccountsByOwner needed)
async function monitorSolSPL() {
  if (!tokensSol || tokensSol.length === 0) {
    console.log("No Solana tokens configured. Skipping SPL monitor.");
    return;
  }
  if (!solAddresses || solAddresses.length === 0) {
    console.log("No Solana addresses configured. Skipping SPL monitor.");
    return;
  }

  // Same style as standalone script
  const RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
  const connection = new Connection(RPC_URL, "confirmed");

  // console.log(
  //   "Solana SPL token monitor starting (devnet, onProgramAccountChange)..."
  // );
  console.log(`RPC URL (SPL): ${RPC_URL}`);

  // For each Solana deposit address in sol_wallets.json
  for (const wallet of solAddresses) {
    const MONITOR_OWNER = new PublicKey(wallet);

    // Build TOKENS array from tokensolana.json
    const TOKENS = tokensSol.map((t) => {
      const mintStr = (t.mint || t.address || "").trim();
      return {
        symbol: t.symbol || mintStr,
        mint: new PublicKey(mintStr),
      };
    });

    // Start a watcher for each mint for this owner
    for (const { symbol, mint } of TOKENS) {
      await watchSplTokenForOwner(connection, MONITOR_OWNER, symbol, mint);
    }
  }
}

// --- Helper: watch a single (owner, mint) pair and write to Mongo ---
async function watchSplTokenForOwner(connection, MONITOR_OWNER, symbol, mint) {
  // console.log(
  //   `\n[SOL SPL] Setting up monitor for ${symbol} (mint: ${mint.toBase58()}) on devnet`
  // );
  // console.log(
  //   `[SOL SPL] Owner (deposit address)  : ${MONITOR_OWNER.toBase58()}`
  // );

  // Associated Token Account for this owner + mint
  const ata = await getAssociatedTokenAddress(mint, MONITOR_OWNER);
  const ataStr = ata.toBase58();
  console.log(`[SOL SPL] ${symbol} ATA for owner  : ${ataStr}`);

  // Last known balances per token account (raw amount)
  const lastBalances = new Map();

  // Try to read initial balance (ATA might not exist yet, that's fine)
  try {
    const bal = await connection.getTokenAccountBalance(ata);
    const raw = BigInt(bal.value.amount);
    lastBalances.set(ataStr, raw);
    // console.log(
    //   `[SOL SPL] Initial ${symbol} balance : ${bal.value.uiAmountString} (decimals: ${bal.value.decimals})`
    // );
  } catch (e) {
    // console.log(
    //   `[SOL SPL] Initial ${symbol} balance : 0 (ATA might not exist yet, will detect when first transfer creates it)`
    // );
    lastBalances.set(ataStr, 0n);
  }

  // Filters for token accounts owned by MONITOR_OWNER & this mint
  const filters = [
    { dataSize: 165 }, // SPL token account size
    { memcmp: { offset: 0, bytes: mint.toBase58() } }, // mint
    { memcmp: { offset: 32, bytes: MONITOR_OWNER.toBase58() } }, // owner
  ];

  connection.onProgramAccountChange(
    TOKEN_PROGRAM_ID,
    async ({ accountId }) => {
      const tokenAccount = accountId.toBase58();

      try {
        // We only care about this ATA
        if (tokenAccount !== ataStr) return;

        const bal = await connection.getTokenAccountBalance(accountId);
        const decimals = bal.value.decimals;
        const newRaw = BigInt(bal.value.amount);

        const prevRaw = lastBalances.get(tokenAccount) || 0n;
        const diff = newRaw - prevRaw;

        // Update cache
        lastBalances.set(tokenAccount, newRaw);

        if (diff === 0n) {
          return; // no change
        }

        const humanDiff = Number(diff) / 10 ** decimals;
        const humanBal = Number(newRaw) / 10 ** decimals;

        if (diff > 0n) {
          // INCOMING SPL
          console.log("---------------------------------------------------");
          console.log(`[SOL SPL] INCOMING ${symbol} DETECTED`);
          console.log(`   Token Account : ${tokenAccount}`);
          console.log(`   Owner         : ${MONITOR_OWNER.toBase58()}`);
          console.log(`   Amount        : +${humanDiff} ${symbol}`);
          console.log(`   New Balance   : ${humanBal} ${symbol}`);

          // Try fetch latest signature touching this token account (approximate)
          let lastSig = null;
          try {
            const sigs = await connection.getSignaturesForAddress(accountId, {
              limit: 1,
            });
            if (sigs && sigs.length > 0) {
              lastSig = sigs[0].signature;
              console.log(`   Tx Signature  : ${lastSig}`);
            }
          } catch (e) {
            console.log("   (Could not fetch tx signature)");
          }

          // Resolve sender ("from") from parsed transaction
          let sender = "unknown";
          if (lastSig) {
            try {
              const parsedTx = await connection.getParsedTransaction(lastSig, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
              });

              if (parsedTx) {
                const instructions =
                  parsedTx.transaction.message.instructions || [];

                for (const ix of instructions) {
                  // parsed SPL-token instruction
                  if (
                    ix.program === "spl-token" &&
                    ix.parsed &&
                    (ix.parsed.type === "transfer" ||
                      ix.parsed.type === "transferChecked")
                  ) {
                    const info = ix.parsed.info || {};
                    // this instruction's destination is OUR tokenAccount (ATA)?
                    if (info.destination === tokenAccount) {
                      const sourceTokenAccount = info.source;

                      try {
                        const accInfo =
                          await connection.getParsedAccountInfo(
                            new PublicKey(sourceTokenAccount)
                          );
                        const owner =
                          accInfo.value?.data?.parsed?.info?.owner || null;
                        if (owner) {
                          sender = owner; // this should be DgmgoT4...
                          console.log(`   Resolved sender wallet: ${sender}`);
                        }
                      } catch (e) {
                        console.log(
                          "   (Could not fetch source token account owner)",
                          e?.message || e
                        );
                      }
                      break; // found our transfer instruction
                    }
                  }
                }

                // Fallback: if still unknown, use first account key (fee payer)
                if (sender === "unknown") {
                  const key0 =
                    parsedTx.transaction.message.accountKeys[0] || null;
                  if (key0) {
                    sender =
                      typeof key0 === "string"
                        ? key0
                        : String(key0.pubkey || key0);
                    console.log(`   Fallback sender: ${sender}`);
                  }
                }
              }
            } catch (e) {
              console.log(
                "   (Error parsing transaction for sender)",
                e?.message || e
              );
            }
          }

          // Dedupe and DB idempotency
          if (lastSig) {
            if (recentTxs.has(lastSig)) return;

            const exists = await Transaction.findOne({
              chain: "solana",
              txHash: lastSig,
            }).lean();
            if (exists) {
              recentTxs.add(lastSig);
              setTimeout(() => recentTxs.delete(lastSig), RECENT_TX_TTL_MS);
              return;
            }
          }

          //  Save to Mongo with REAL sender
          await Transaction.create({
            type: "deposit",
            chain: "solana", // or "solana-devnet" if you prefer
            symbol,
            from: sender, // sender address (e.g. DgmgoT4...)
            to: MONITOR_OWNER.toBase58(),
            amount: humanDiff,
            txHash: lastSig,
            timestamp: new Date(),
            metadata: {
              mint: mint.toBase58(),
              ata: tokenAccount,
              newBalance: humanBal,
            },
          });

          // Update UserBalance for the SENDER (credit the user who sent tokens)
          if (sender !== "unknown") {
            await UserBalance.findOneAndUpdate(
              { address: sender, chain: "solana", symbol },
              { $inc: { balance: humanDiff } },
              { upsert: true, new: true }
            );
          }

          if (lastSig) {
            recentTxs.add(lastSig);
            setTimeout(() => recentTxs.delete(lastSig), RECENT_TX_TTL_MS);
          }
        } else {
          // OUTGOING (optional log)
          console.log("---------------------------------------------------");
          console.log(`[SOL SPL] OUTGOING ${symbol} DETECTED`);
          console.log(
            `   Amount        : ${Number(-diff) / 10 ** decimals} ${symbol}`
          );
          console.log(`   New Balance   : ${humanBal} ${symbol}`);
        }
      } catch (err) {
        console.error(
          `Error reading balance for token account ${tokenAccount} (${symbol}):`,
          err?.message || err
        );
      }
    },
    "confirmed",
    filters
  );

  // console.log(
  //   `[SOL SPL] Listening for ${symbol} transfers TO ${MONITOR_OWNER.toBase58()} on devnet...\n`
  // );
}


/* ------------------------------------------------------------------
   MAIN
-------------------------------------------------------------------*/
async function main() {
  console.log("Starting Deposit Monitors...");

  // Load deposit addresses from Mongo before starting monitors
  await reloadDepositAddresses();
  // Periodically refresh addresses (for newly created wallets)
  setInterval(reloadDepositAddresses, 60_000);

  // Tokens
  monitorETH();
  monitorBSC();
  monitorTRON();
  monitorSolSPL();
  monitorPOLY();

  // Native
  monitorETHNative();
  monitorBNBNative();
  monitorTRXNative();
  monitorBTCNative();
  monitorSolNative();
  monitorPolygonNative();
}

// Initialize Solana connection and then start main()
(async () => {
  try {
    solanaConnection = await pickWorkingSolanaRpc(
      RPC_CANDIDATES,
      Number(process.env.SOL_RPC_TIMEOUT_MS || 10000)
    );
  } catch (e) {
    console.error(
      "No working Solana RPC available, falling back to env:",
      e?.message || e
    );
    solanaConnection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
      { commitment: "finalized" }
    );
  }

  try {
    await main();
  } catch (err) {
    console.error("main() failed:", err);
  }
})();
