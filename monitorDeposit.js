//monitorDeposit.js
require("dotenv").config();
const axios = require("axios");

const fs = require("fs");
const Web3 = require("web3");
const { ethers } = require("ethers");
const TronWeb = require("tronweb");
const mongoose = require("mongoose");

const Transaction = require("./src/models/transactionmodels");
const UserBalance = require("./src/models/userBalancemodels"); // ✅ Add this line

// === MongoDB Setup ===
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

// in-memory dedupe (put this near the top, after your requires)
const recentTxs = new Set();   // dedupe for EVM native/token tx hashes
const RECENT_TX_TTL_MS = Number(process.env.RECENT_TX_TTL_MS || 5 * 60 * 1000); 
// === Load Wallets ===
const ethWallets = JSON.parse(fs.readFileSync("./eth_wallets.json"));
const polygonWallets = JSON.parse(fs.readFileSync("./eth_wallets.json"));
const bscWallets = JSON.parse(fs.readFileSync("./bsc_wallets.json"));
const tronWallets = JSON.parse(fs.readFileSync("./tron_wallets.json"));
// Load BTC Wallets (Testnet)
const btcWallets = JSON.parse(fs.readFileSync("./derived_wallets_btc2.json"));

const ethAddresses = ethWallets.map((w) => w.address.toLowerCase());
const bscAddresses = bscWallets.map((w) => w.address.toLowerCase());
const polygonAddresses = polygonWallets.map((w) => w.address.toLowerCase());
const tronAddresses = tronWallets.map((w) => w.address);
const btcAddresses = btcWallets.map((w) => w.address);

// === Load Tokens ===
const erc20Abi = JSON.parse(fs.readFileSync("./erc20.json"));
const trc20Abi = JSON.parse(fs.readFileSync("./trc20.json"));
const tokensEth = JSON.parse(fs.readFileSync("./tokenethereum.json"));
const tokensBsc = JSON.parse(fs.readFileSync("./tokenbsc.json"));
const tokensTron = JSON.parse(fs.readFileSync("./tokentron.json"));
const tokensPolygon = JSON.parse(fs.readFileSync("./tokenpolygon.json"));
// === Setup Providers ===
const ethProvider = new ethers.providers.JsonRpcProvider(process.env.ETH_NODE_URL);
const bscWeb3 = new Web3(process.env.BSC_NODE_WSS);
const tronWeb = new TronWeb({
    fullHost: process.env.TRON_NODE_URL,
   // privateKey: tronWallets[0].privateKey,
});


tronWeb.setEventServer("https://api.shasta.trongrid.io");

// === Monitor ETH Native Transfers ===
async function monitorETHNative() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.ETH_NODE_URL);
  let lastBlock = await provider.getBlockNumber();

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();

      for (let i = lastBlock + 1; i <= currentBlock; i++) {
        const block = await provider.getBlockWithTransactions(i);

        for (const tx of block.transactions) {
  if (tx.to && ethAddresses.includes(tx.to.toLowerCase())) {
    const amount = parseFloat(ethers.utils.formatEther(tx.value));

    console.log(`💰 Native ETH received: ${amount} ETH from ${tx.from} to ${tx.to}`);

    await Transaction.create({
      chain: "ethereum",
      type: "deposit",
      symbol: "ETH",
      from: tx.from,
      to: tx.to,
      amount,
      txHash: tx.hash,
    });

    await UserBalance.findOneAndUpdate(
      { address: tx.from.toLowerCase(), chain: "ethereum", symbol: "ETH" },
      { $inc: { balance: amount } },
      { upsert: true, new: true }
    );
  }
}
      }

      lastBlock = currentBlock;
    } catch (err) {
      console.error("❌ Error in monitorETHNative:", err);
    }
  }, 15_000);
}

// === Monitor BNB Native Transfers ===
async function monitorBNBNative() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.BSC_NODE_URL);
  let lastBlock = await provider.getBlockNumber();

  console.log("🟡 BNB native monitor starting at block", lastBlock);

  const POLL_MS = Number(process.env.BSC_POLL_MS || 15_000);

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();

      // nothing new
      if (currentBlock <= lastBlock) return;

      for (let i = lastBlock + 1; i <= currentBlock; i++) {
        let block;
        try {
          block = await provider.getBlockWithTransactions(i);
        } catch (e) {
          console.warn(`⚠️ Failed to fetch BSC block ${i}:`, e.message || e);
          // don't advance lastBlock so we retry this block next poll
          break;
        }

        if (!block || !Array.isArray(block.transactions)) continue;

        for (const tx of block.transactions) {
          try {
            if (!tx || !tx.to) continue;
            const toLower = tx.to.toLowerCase();
            if (!bscAddresses.includes(toLower)) continue; // not one of our monitored addresses

            // quick in-memory dedupe
            if (recentTxs.has(tx.hash)) {
              // already processing/processed recently — skip
              // console.log("skip recent tx", tx.hash);
              continue;
            }

            // Check DB to make sure we haven't already recorded this tx (idempotent check)
            // (Transaction is your model from ./src/models/transactionmodels)
            const already = await Transaction.findOne({ chain: "bsc", txHash: tx.hash }).lean();
            if (already) {
              // console.log("skip db-existing tx", tx.hash);
              // add to recentTxs to reduce future checks for the same tx in-memory
              recentTxs.add(tx.hash);
              setTimeout(() => recentTxs.delete(tx.hash), RECENT_TX_TTL_MS);
              continue;
            }

            const amount = parseFloat(ethers.utils.formatEther(tx.value));
            console.log(`💰 Native BNB received: ${amount} BNB from ${tx.from} to ${tx.to}`);

            // Save to DB
            await Transaction.create({
              chain: "bsc",
              type: "deposit",
              symbol: "BNB",
              from: tx.from,
              to: tx.to,
              amount,
              txHash: tx.hash,
            });

            // Update user balance (address normalized to lower)
            await UserBalance.findOneAndUpdate(
              { address: tx.to.toLowerCase(), chain: "bsc", symbol: "BNB" },
              { $inc: { balance: amount } },
              { upsert: true, new: true }
            );

            // mark in-memory as seen
            recentTxs.add(tx.hash);
            setTimeout(() => recentTxs.delete(tx.hash), RECENT_TX_TTL_MS);
          } catch (innerErr) {
            console.error("⚠️ Error processing BNB tx:", innerErr?.message || innerErr);
            // continue processing other txs in the block
          }
        } // end transactions loop

      } // end block loop

      // advance lastBlock only after we've processed up to currentBlock
      lastBlock = currentBlock;
    } catch (err) {
      console.error("❌ Error in monitorBNBNative:", err?.message || err);
    }
  }, POLL_MS);
}

// === Monitor Polygon native MATIC transfers (polling) ===
async function monitorPolygonNative() {
  if (!polygonAddresses.length) {
    console.log("⚪ No Polygon addresses configured for native monitor. Skipping Polygon native monitor.");
    return;
  }

  const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_NODE_URL) // already created above
  let lastBlock = await provider.getBlockNumber();
  console.log("🟢 Polygon native monitor starting at block", lastBlock);

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
          console.warn(`⚠️ Failed to fetch Polygon block ${i}:`, e?.message || e);
          break; // try again next poll
        }
        if (!block || !Array.isArray(block.transactions)) continue;

        for (const tx of block.transactions) {
          try {
            if (!tx || !tx.to) continue;
            const toLower = tx.to.toLowerCase();
            if (!polygonAddresses.includes(toLower)) continue;

            // in-memory dedupe
            if (recentTxs.has(tx.hash)) continue;

            // DB idempotency check
            const exists = await Transaction.findOne({ chain: "polygon", txHash: tx.hash }).lean();
            if (exists) {
              recentTxs.add(tx.hash);
              setTimeout(() => recentTxs.delete(tx.hash), RECENT_TX_TTL_MS);
              continue;
            }

            // compute sweep/amount
            const amount = parseFloat(ethers.utils.formatEther(tx.value));
            console.log(`💰 Native MATIC received: ${amount} MATIC from ${tx.from} to ${tx.to} (tx ${tx.hash})`);

            await Transaction.create({
              chain: "polygon",
              type: "deposit",
              symbol: "MATIC",
              from: tx.from,
              to: tx.to,
              amount,
              txHash: tx.hash,
            });

            await UserBalance.findOneAndUpdate(
              { address: from.toLowerCase(), chain: "polygon", symbol: "MATIC" },
              { $inc: { balance: amount } },
              { upsert: true, new: true }
            );

            // mark seen in memory
            recentTxs.add(tx.hash);
            setTimeout(() => recentTxs.delete(tx.hash), RECENT_TX_TTL_MS);
          } catch (inner) {
            console.warn("⚠️ Error processing Polygon native tx:", inner?.message || inner);
          }
        } // tx loop
      } // block loop

      lastBlock = currentBlock;
    } catch (err) {
      console.error("❌ Error in monitorPolygonNative:", err?.message || err);
    }
  }, POLL_MS);
}






// === Monitor TRX Native Transfers ===
async function monitorTRXNative() {
  // Initialize lastBlockNum from current block to avoid importing history on restart
  try {
    const currentBlock = await tronWeb.trx.getCurrentBlock();
    var lastBlockNum = currentBlock.block_header.raw_data.number;
  } catch (e) {
    console.warn("⚠️ Could not read current TRON block on startup:", e.message || e);
    // fallback: start from 0 so it will try to catch up (only do this if you intentionally want history)
    lastBlockNum = 0;
  }

  console.log("🟠 TRX native monitor starting at block", lastBlockNum);

  // small per-address backoff map (in case RPC fails)
  const addressBackoff = {};

  // idempotent save helper
  async function saveTrxIfNew({ txId, fromAddr, toAddr, amount }) {
    if (!txId) return false;
    if (recentTxs.has(txId)) return false; // in-memory dedupe

    // DB check for existing tx
    const exists = await Transaction.findOne({ chain: "tron", txHash: txId }).lean();
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
        timestamp: new Date()
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
      // ignore duplicate key race (if you add the DB index below, races will throw 11000)
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

      // nothing new
      if (currentBlockNum <= lastBlockNum) return;

      for (let b = lastBlockNum + 1; b <= currentBlockNum; b++) {
        // optional small backoff if RPC failing for specific block
        try {
          const block = await tronWeb.trx.getBlock(b);
          if (!block || !Array.isArray(block.transactions)) {
            // some nodes return undefined for empty blocks; proceed
            continue;
          }

          for (const tx of block.transactions || []) {
            try {
              // defensive checks - some tx shapes vary
              const txId = tx.txID || tx.txid || (tx.raw_data && tx.raw_data.txID) || null;
              if (!txId) continue;

              // avoid repeated processing within poll window
              if (recentTxs.has(txId)) continue;

              // extract from/to/amount safely
              // older code: const txRaw = tx.raw_data.contract[0].parameter.value;
              let txRaw = null;
              try { txRaw = tx.raw_data && tx.raw_data.contract && tx.raw_data.contract[0] && tx.raw_data.contract[0].parameter && tx.raw_data.contract[0].parameter.value; } catch(e){}
              if (!txRaw) {
                // if structure different, attempt to get via getTransactionInfo (slower)
                try {
                  const info = await tronWeb.trx.getTransactionInfo(txId);
                  // info may contain contractRet and other fields; amount may be in raw_data as well
                } catch (e) {
                  // skip if can't parse
                }
              }

              if (!txRaw) continue;

              const toAddr = tronWeb.address.fromHex(txRaw.to_address);
              const fromAddr = tronWeb.address.fromHex(txRaw.owner_address);
              const amount = (txRaw.amount || 0) / 1e6;

              if (!tronAddresses.includes(toAddr)) continue;

              // DB idempotent save
              await saveTrxIfNew({ txId, fromAddr, toAddr, amount });

              // debug log (only when actually new or not seen recently)
              if (recentTxs.has(txId)) {
                console.log(`💰 Native TRX received: ${amount} TRX from ${fromAddr} to ${toAddr} (tx ${txId})`);
              }
            } catch (inner) {
              console.warn("⚠️ Error processing TRX tx inside block:", inner?.message || inner);
            }
          } // tx loop

          // advance lastBlockNum as we processed this block
          lastBlockNum = b;
        } catch (blkErr) {
          console.warn(`⚠️ Failed to fetch/process TRON block ${b}:`, blkErr?.message || blkErr);
          // don't advance lastBlockNum so we retry this block on next poll
          break;
        }
      } // block loop
    } catch (err) {
      console.error("❌ Error in monitorTRXNative:", err?.message || err);
    }
  }, POLL_MS);
}

// === Start MonitoringToken ===
async function monitorETH() {
    for (const token of tokensEth) {
        const contract = new ethers.Contract(token.address, erc20Abi, ethProvider);
        contract.on("Transfer", async (from, to, value, event) => {
            if (ethAddresses.includes(to.toLowerCase())) {
                const amount = ethers.utils.formatUnits(value, token.decimals);
                console.log(`📥 ETH: ${token.symbol} ${amount} from ${from} to ${to}`);

                const deposit = await Transaction.create({
                    type: "deposit",
                    chain: "ethereum",
                    symbol: token.symbol,
                    from,
                    to,
                    amount,
                    txHash: event.transactionHash,
                });

                // ✅ Update balance
                await UserBalance.findOneAndUpdate(
                    { address: from.toLowerCase(), chain: "ethereum", symbol: token.symbol },
                    { $inc: { balance: parseFloat(amount) } },
                    { upsert: true, new: true }
                );
            }
        });
    }
}

// === Start Monitoring Token ===

// Replace your monitorBSC() with this polling-based implementation.
// Requires BSC_NODE_URL env (HTTP/HTTPS), not the WSS provider.
async function monitorBSC() {
  const httpProvider = process.env.BSC_NODE_URL;
  if (!httpProvider) {
    console.error("❌ BSC_NODE_URL (HTTP) is required for polling-based monitor");
    return;
  }
  const Web3 = require("web3");
  const web3http = new Web3(httpProvider);

  // track last processed block per token contract
  const lastProcessed = {};

  // default polling interval
  const POLL_MS = Number(process.env.BSC_POLL_MS || 15_000);

  // For each token, call getPastEvents from lastProcessed+1 to latest
  async function pollOnce() {
    try {
      const latest = await web3http.eth.getBlockNumber();

      for (const token of tokensBsc) {
        try {
          const abi = erc20Abi;
          const contract = new web3http.eth.Contract(abi, token.address);
          const key = token.address.toLowerCase();
          const fromBlock = Math.max( (lastProcessed[key] || (latest - 10)), 0 );
          const toBlock = latest;

          // get Transfer events
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

              const amount = parseFloat(value) / (10 ** token.decimals || 18);
              console.log(`📥 BSC: ${token.symbol} ${amount} from ${from} to ${to}`);

              await Transaction.create({
                type: "deposit",
                chain: "bsc",
                symbol: token.symbol,
                from,
                to,
                amount,
                txHash: e.transactionHash,
              });

              await UserBalance.findOneAndUpdate(
                { address: from.toLowerCase(), chain: "bsc", symbol: token.symbol },
                { $inc: { balance: parseFloat(amount) } },
                { upsert: true, new: true }
              );

            } catch (innerErr) {
              console.warn("⚠️ error processing single BSC event:", innerErr?.message || innerErr);
            }
          }

          lastProcessed[key] = toBlock;
        } catch (errToken) {
          console.warn("⚠️ BSC token poll error for", token.address, errToken?.message || errToken);
        }
      }
    } catch (err) {
      console.error("❌ BSC poll failed:", err?.message || err);
    }
  }

  // initial poll and then interval
  await pollOnce();
  setInterval(pollOnce, POLL_MS);
}

// === Monitor Polygon ERC-20 Tokens (real-time, uses contract.on Transfer) ===
async function monitorPOLY() {
  if (!tokensPolygon || tokensPolygon.length === 0) {
    console.log("⚪ No Polygon tokens configured (tokenpolygon.json). Skipping Polygon token monitor.");
    return;
  }

  console.log("🔷 Polygon token monitor starting...");
   const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_NODE_URL) // already created above

  for (const token of tokensPolygon) {
    try {
      if (!token || !token.address) continue;
      const contract = new ethers.Contract(token.address, erc20Abi, provider);
      console.log(`📡 Watching POLYGON token: ${token.symbol || token.address} at ${token.address}`);

      contract.on("Transfer", async (from, to, value, event) => {
        try {
          if (!to) return;
          const toLower = String(to).toLowerCase();
          if (!polygonAddresses.includes(toLower)) return;

          // dedupe (in-memory); also check DB below for safety
          if (recentTxs.has(event.transactionHash)) return;

          // DB idempotency check
          const already = await Transaction.findOne({ chain: "polygon", txHash: event.transactionHash }).lean();
          if (already) {
            recentTxs.add(event.transactionHash);
            setTimeout(() => recentTxs.delete(event.transactionHash), RECENT_TX_TTL_MS);
            return;
          }

          const amountStr = ethers.utils.formatUnits(value, token.decimals || 18);
          const amount = parseFloat(amountStr);

          console.log(`📥 POLYGON: ${token.symbol} ${amountStr} from ${from} to ${to} (tx ${event.transactionHash})`);

          // Save transaction
          await Transaction.create({
            type: "deposit",
            chain: "polygon",
            symbol: token.symbol || token.address,
            from,
            to,
            amount,
            txHash: event.transactionHash,
          });

          // Update user balance; store address normalized to lower-case
          await UserBalance.findOneAndUpdate(
            { address: from.toLowerCase(), chain: "polygon", symbol: token.symbol || token.address },
            { $inc: { balance: amount } },
            { upsert: true, new: true }
          );

          // mark in-memory as seen
          recentTxs.add(event.transactionHash);
          setTimeout(() => recentTxs.delete(event.transactionHash), RECENT_TX_TTL_MS);
        } catch (e) {
          console.error("🔥 Error in Polygon token event handler:", e?.message || e);
        }
      });
    } catch (e) {
      console.warn("⚠️ Failed to attach Polygon token listener:", token?.address, e?.message || e);
    }
  }
}


tronWeb.setEventServer("https://api.shasta.trongrid.io");
async function monitorTRON() {
    try {
        for (const token of tokensTron) {
            const contract = await tronWeb.contract(trc20Abi, token.address);
            console.log(`📡 Watching TRON token: ${token.symbol} at ${token.address}`);

            // --- Real-time monitor with .watch() ---
            contract.Transfer().watch(async (err, event) => {
                try {
                    if (err) {
                        console.error(`❌ Watch error for ${token.symbol}:`, err);
                        return;
                    }

                    if (!event?.result) return;

                    const { from, to, value } = event.result;
                    const toBase58 = tronWeb.address.fromHex(to);
                    const fromBase58 = tronWeb.address.fromHex(from);

                    console.log(`🔔 Event: ${token.symbol} ${value} from ${from} to ${toBase58}`);

                    if (tronAddresses.includes(toBase58)) {
                        const amount = parseFloat(value) / (10 ** token.decimals);

                        console.log(`📥 TRON DEPOSIT: ${amount} ${token.symbol} → ${toBase58}`);

                        await Transaction.create({
                            type: "deposit",
                            chain: "tron",
                            symbol: token.symbol,
                            from,
                            to: toBase58,
                            amount,
                            txHash: event.transaction
                        });

                        await UserBalance.findOneAndUpdate(
                           { address: fromBase58, chain: "tron", symbol: token.symbol },
                            { $inc: { balance: amount } },
                            { upsert: true, new: true }
                        );
                    }
                } catch (e) {
                    console.error("🔥 Error in TRON event handler:", e);
                }
            });
        }
    } catch (e) {
        console.error("🔥 Error in monitorTRON:", e);
    }
}

// small in-memory dedupe for all chains (put near your other dedupe sets)
// const recentTxs = new Set(); // already used elsewhere — reuse here
// const RECENT_TX_TTL_MS = Number(process.env.RECENT_TX_TTL_MS || 5 * 60 * 1000); // 5 minutes

async function monitorBTCNative() {
  console.log("🟡 BTC Monitor started (Testnet)");
  const BTC_POLL_MS = Number(process.env.BTC_POLL_MS || 30_000);
  const axiosInstance = axios.create({ timeout: 20_000 });

  // addressBackoff prevents hammering an address that returns errors / 429s
  const addressBackoff = {};
  // store last seen tx id per address (persisted across runtime via DB init)
  const lastSeenTxId = {};

  // initialize lastSeenTxId from DB so we don't reimport history on restart
  for (const address of btcAddresses) {
    try {
      // find latest TX for this address from DB (if any)
      const latest = await Transaction.findOne({ chain: "bitcoin", to: address }).sort({ timestamp: -1 }).lean();
      if (latest && latest.txHash) lastSeenTxId[address] = latest.txHash;
      else lastSeenTxId[address] = null;
    } catch (e) {
      console.warn("⚠️ Could not init lastSeen for", address, e.message || e);
      lastSeenTxId[address] = null;
    }
  }

  // helper: idempotent save (checks DB first)
  async function saveBtcDepositIfNew({ address, txId, amount, from }) {
    if (!txId) return false;
    // in-memory dedupe
    if (recentTxs.has(txId)) return false;
    // quick DB check
    const already = await Transaction.findOne({ chain: "bitcoin", txHash: txId }).lean();
    if (already) {
      recentTxs.add(txId);
      setTimeout(() => recentTxs.delete(txId), RECENT_TX_TTL_MS);
      return false;
    }
    // attempt insert
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
      // duplicate key or other race could throw 11000 — ignore duplicates
      if (e && e.code === 11000) {
        // already inserted by another process
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
        if (addressBackoff[address] && Date.now() < addressBackoff[address]) {
          continue; // still backing off
        }

        // fetch recent txs (most recent first)
        const url = `https://blockstream.info/testnet/api/address/${address}/txs`;
        const res = await axiosInstance.get(url);
        const txs = Array.isArray(res.data) ? res.data : [];

        // if nothing returned, skip
        if (!txs.length) continue;

        // build list of unseen txids (stop when we hit lastSeenTxId[address])
        const lastSeen = lastSeenTxId[address];
        const unseen = [];
        for (const t of txs) {
          if (!t || !t.txid) continue;
          if (lastSeen && t.txid === lastSeen) break;
          unseen.push(t); // newest->oldest
        }

        // process oldest -> newest so order is chronological
        unseen.reverse();

        for (const t of unseen) {
          try {
            const txId = t.txid;
            // small in-memory dedupe (handle if RPC returns duplicates)
            if (recentTxs.has(txId)) continue;

            // find any vout that pays our address
            for (const vout of t.vout || []) {
              if (vout.scriptpubkey_address === address) {
                const amount = (vout.value || 0) / 1e8;
                // from heuristics: try to get from vin[0] prevout or set unknown
                const from = t.vin?.[0]?.prevout?.scriptpubkey_address || "unknown";

                // idempotent save
                await saveBtcDepositIfNew({ address, txId, amount, from });
                break; // if multiple vouts to same address, we handle once
              }
            }

            // update lastSeenTxId for this address to newest processed tx (we'll set final below too)
            // but keep updating as we go so if process crashes we won't re-process the ones we did
            lastSeenTxId[address] = txId;
          } catch (inner) {
            console.warn("⚠️ Error processing BTC tx:", inner?.message || inner);
          }
        }

        // if we processed at least one tx, ensure lastSeen set to top-most (txs[0])
        if (txs.length > 0) lastSeenTxId[address] = txs[0].txid;
      } catch (err) {
        console.error(`❌ Error checking BTC for address ${address}:`, err?.response?.status || err.message);
        if (err?.response?.status === 429) {
          addressBackoff[address] = Date.now() + (Number(process.env.BTC_BACKOFF_MS) || 60_000);
          console.warn(`⚠️ 429 for ${address} — backing off for 60s`);
        } else {
          // transient network error — small backoff
          addressBackoff[address] = Date.now() + 5_000;
        }
      }
    } // end for addresses
  }, BTC_POLL_MS);
}

// --- Solana monitors (paste into monitorDeposit.js) ---
const { Connection, PublicKey } = require("@solana/web3.js");

// try to read a dedicated sol wallets file, otherwise fallback to user_walletsfinalmultichain.json
let solWallets = [];
try {
  solWallets = JSON.parse(fs.readFileSync("./sol_wallets.json"));
} catch (e) {
  try {
    const all = JSON.parse(fs.readFileSync("./user_walletsfinalmultichain.json"));
    // heuristics: include addresses that look like Solana (base58 length 32-44)
    solWallets = (all || []).filter((w) => w && w.address && typeof w.address === "string" && w.address.length >= 32 && w.address.length <= 64);
  } catch (e2) {
    solWallets = [];
  }
}
const solAddresses = solWallets.map((w) => (w && w.address ? w.address : "")).filter(Boolean);

// Solana RPC connection
const SOL_RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const solConnection = new Connection(SOL_RPC, { commitment: "confirmed", confirmTransactionInitialTimeout: 20_000 });

// small store for last seen signature per address
const solLastSig = {};

/**
 * Helper: safe PublicKey creation
 */
function safePubkey(addr) {
  try {
    return new PublicKey(addr);
  } catch (e) {
    return null;
  }
}

/**
 * Polling-based monitor for native SOL transfers to monitored addresses.
 * Uses getSignaturesForAddress + getParsedTransaction to inspect transfers.
 */
async function monitorSOLNative() {
  if (!solAddresses.length) {
    console.log("⚪ No Solana addresses configured for monitoring. Skipping SOL monitor.");
    return;
  }
  console.log("🟣 SOL Monitor started");

  const POLL_MS = Number(process.env.SOL_POLL_MS || 15_000);

  async function pollOnce() {
    try {
      for (const addr of solAddresses) {
        const pub = safePubkey(addr);
        if (!pub) continue;

        // use 'finalized' commitment for more stable results
        const sigInfos = await solConnection.getSignaturesForAddress(pub, { limit: 50, commitment: "finalized" });
        if (!sigInfos || sigInfos.length === 0) continue;

        const lastSeen = solLastSig[addr];
        const unseen = [];
        for (const info of sigInfos) { // newest -> oldest
          const s = info.signature;
          if (lastSeen && s === lastSeen) break; // stop at already processed
          unseen.push(s);
        }

        if (unseen.length === 0) continue;

        unseen.reverse(); // process oldest -> newest

        for (const sig of unseen) {
          // very small in-memory dedupe
          if (recentSigs.has(sig)) continue;
          recentSigs.add(sig);
          setTimeout(() => recentSigs.delete(sig), 5 * 60 * 1000);

          const parsed = await solConnection.getParsedTransaction(sig, { commitment: "finalized" });
          if (!parsed || !parsed.transaction) continue;

          // check top-level instructions
          let handled = false;
          const { transaction } = parsed;
          const msg = transaction.message || {};
          const instructions = msg.instructions || [];

          for (const instr of instructions) {
            if (instr.program === "system" && instr.parsed && instr.parsed.type === "transfer") {
              const info = instr.parsed.info || {};
              if (info && (info.destination === addr || info.to === addr)) {
                const lamports = BigInt(info.lamports ?? info.amount ?? 0);
                if (lamports > 0n) {
                  const amount = Number(lamports) / 1e9;
                  console.log(`📥 SOL deposit: ${amount} SOL → ${addr} (sig ${sig})`);
                  try {
                    // idempotent insert: rely on DB unique index and catch duplicate error
                    await Transaction.create({
                      chain: "solana",
                      type: "deposit",
                      symbol: "SOL",
                      from: (info.source || info.from || "unknown"),
                      to: addr,
                      amount,
                      txHash: sig,
                    });
                    await UserBalance.findOneAndUpdate(
                      { address: addr, chain: "solana", symbol: "SOL" },
                      { $inc: { balance: amount } },
                      { upsert: true, new: true }
                    );
                  } catch (e) {
                    // duplicate or other error — ignore duplicates
                    if (e.code === 11000) {
                      // duplicate key (already saved) — safe to ignore
                    } else {
                      console.warn("⚠️ TX insert error:", e.message || e);
                    }
                  }
                  handled = true;
                }
              }
            }
          }

          // check inner instructions if not handled
          if (!handled && parsed.meta && Array.isArray(parsed.meta.innerInstructions)) {
            for (const inner of parsed.meta.innerInstructions) {
              for (const ii of inner.instructions || []) {
                const parsedInner = ii.parsed;
                if (ii.program === "system" && parsedInner && parsedInner.type === "transfer") {
                  const info = parsedInner.info || {};
                  if (info && (info.destination === addr || info.to === addr)) {
                    const lamports = BigInt(info.lamports ?? info.amount ?? 0);
                    if (lamports > 0n) {
                      const amount = Number(lamports) / 1e9;
                      console.log(`📥 SOL deposit (inner): ${amount} SOL → ${addr} (sig ${sig})`);
                      try {
                        await Transaction.create({
                          chain: "solana",
                          type: "deposit",
                          symbol: "SOL",
                          from: (info.source || info.from || "unknown"),
                          to: addr,
                          amount,
                          txHash: sig,
                        });
                        await UserBalance.findOneAndUpdate(
                          { address: addr, chain: "solana", symbol: "SOL" },
                          { $inc: { balance: amount } },
                          { upsert: true, new: true }
                        );
                      } catch (e) {
                        if (e.code !== 11000) console.warn("⚠️ TX insert error:", e.message || e);
                      }
                      handled = true;
                      break;
                    }
                  }
                }
              }
              if (handled) break;
            }
          }
        } // unseen loop

        // update last seen to newest signature returned by RPC
        solLastSig[addr] = sigInfos[0].signature;
      } // addr loop
    } catch (err) {
      console.error("❌ Error in monitorSOLNative:", err?.message || err);
    }
  }

  // initial run then interval
  await pollOnce();
  setInterval(pollOnce, POLL_MS);
}


/**
 * Monitor SPL token transfers to monitored addresses.
 * Approach: for each monitored address, fetch recent signatures and parse token instructions
 */
async function monitorSPL() {
  if (!solAddresses.length) {
    console.log("⚪ No Solana addresses configured for monitoring (sol_wallets.json or user_walletsfinalmultichain.json). Skipping SPL monitor.");
    return;
  }
  console.log("🔷 SPL Monitor started");

  const POLL_MS = Number(process.env.SOL_POLL_MS || 15_000);

  async function pollOnce() {
    try {
      for (const addr of solAddresses) {
        const pub = safePubkey(addr);
        if (!pub) continue;

        const sigInfos = await solConnection.getSignaturesForAddress(pub, { limit: 20 });
        if (!sigInfos || sigInfos.length === 0) continue;
        const sigs = sigInfos.map(s => s.signature).reverse();

        for (const sig of sigs) {
          if (solLastSig[addr] && sig === solLastSig[addr]) continue;

          const parsed = await solConnection.getParsedTransaction(sig, { commitment: "confirmed" });
          if (!parsed || !parsed.transaction) continue;

          // token transfers appear as parsed instructions with program 'spl-token' and type 'transfer' or 'transferChecked'
          const msg = parsed.transaction.message;
          const instructions = msg.instructions || [];

          // helper to process a parsed token transfer instruction
          const processParsedTokenInstr = async (instr) => {
            if (!instr || instr.program !== "spl-token" || !instr.parsed) return false;
            const p = instr.parsed;
            const typ = p.type;
            if (!typ) return false;
            const info = p.info || {};
            // for transfer/transferChecked the 'destination' field is common
            const dest = info.destination || info.to;
            const src = info.source || info.from;
            const amtRaw = info.amount ?? info.tokenAmount?.amount;
            const decimals = info.decimals ?? (info.tokenAmount?.decimals ?? null);
            if (!dest) return false;
            if (dest !== addr) return false;
            if (!amtRaw) return false;
            // try to compute float amount
            const amount = decimals !== null ? (Number(amtRaw) / (10 ** decimals)) : Number(amtRaw);
            const mint = info.mint || (info?.tokenAmount?.uiAmountString ? null : null);

            console.log(`📥 SPL deposit: ${amount} token (sig ${sig}) → ${dest} (src ${src || "unknown"})`);

            await Transaction.create({
              chain: "solana",
              type: "deposit",
              symbol: mint || "SPL",
              from: src || "unknown",
              to: dest,
              amount,
              txHash: sig,
            });

            await UserBalance.findOneAndUpdate(
              { address: dest, chain: "solana", symbol: mint || "SPL" },
              { $inc: { balance: amount } },
              { upsert: true, new: true }
            );

            return true;
          };

          // check top-level parsed instrs
          let found = false;
          for (const instr of instructions) {
            try {
              if (await processParsedTokenInstr(instr)) { found = true; break; }
            } catch (e) {}
          }

      //check inner instructions (some token transfers show there)
          if (!found && parsed.meta && Array.isArray(parsed.meta.innerInstructions)) {
            for (const inner of parsed.meta.innerInstructions) {
              for (const ii of inner.instructions || []) {
                try {
                  if (await processParsedTokenInstr(ii)) { found = true; break; }
                } catch (e) {}
              }
              if (found) break;
            }
          }

          // mark seen
          solLastSig[addr] = sig;
        } // sig loop
      } // addr loop
    } catch (err) {
      console.error("❌ Error in monitorSPL:", err?.message || err);
    }
  }

  await pollOnce();
  setInterval(pollOnce, POLL_MS);
}

async function main() {
    console.log("🚀 Starting Deposit Monitors...");
    monitorETH();  //Token
    monitorBSC();  //Token
    monitorTRON(); //Token
    monitorSPL();   //Token
    monitorPOLY(); //Token
  

    monitorETHNative();   // ETH
    monitorBNBNative();   // BNB
    monitorTRXNative();   // TRX
    monitorBTCNative();   //BTC
    monitorSOLNative();   //SOL
    monitorPolygonNative(); //POL
}
main();
