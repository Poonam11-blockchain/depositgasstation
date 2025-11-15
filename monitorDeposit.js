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
const bscWallets = JSON.parse(fs.readFileSync("./bsc_wallets.json"));
const tronWallets = JSON.parse(fs.readFileSync("./tron_wallets.json"));
// Load BTC Wallets (Testnet)
const btcWallets = JSON.parse(fs.readFileSync("./derived_wallets_btc2.json"));

const ethAddresses = ethWallets.map((w) => w.address.toLowerCase());
const bscAddresses = bscWallets.map((w) => w.address.toLowerCase());
const tronAddresses = tronWallets.map((w) => w.address);
const btcAddresses = btcWallets.map((w) => w.address);

// === Load Tokens ===
const erc20Abi = JSON.parse(fs.readFileSync("./erc20.json"));
const trc20Abi = JSON.parse(fs.readFileSync("./trc20.json"));
const tokensEth = JSON.parse(fs.readFileSync("./tokenethereum.json"));
const tokensBsc = JSON.parse(fs.readFileSync("./tokenbsc.json"));
const tokensTron = JSON.parse(fs.readFileSync("./tokentron.json"));

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
// async function monitorBNBNative() {
//   // Correct: pass only the RPC URL here
//   const provider = new ethers.providers.JsonRpcProvider(process.env.BSC_NODE_URL);

//   // Optional: wrap requests with axios or use AbortController for custom timeouts
//   let lastBlock = await provider.getBlockNumber();

//   setInterval(async () => {
//     try {
//       const currentBlock = await provider.getBlockNumber();

//       for (let i = lastBlock + 1; i <= currentBlock; i++) {
//         const block = await provider.getBlockWithTransactions(i);

//         for (const tx of block.transactions) {
//           if (tx.to && bscAddresses.includes(tx.to.toLowerCase())) {
//             const amount = parseFloat(ethers.utils.formatEther(tx.value));

//             console.log(`💰 Native BNB received: ${amount} BNB from ${tx.from} to ${tx.to}`);

//             await Transaction.create({
//               chain: "bsc",
//               type: "deposit",
//               symbol: "BNB",
//               from: tx.from,
//               to: tx.to,
//               amount,
//               txHash: tx.hash,
//             });

//             await UserBalance.findOneAndUpdate(
//               { address: tx.to.toLowerCase(), chain: "bsc", symbol: "BNB" },
//               { $inc: { balance: amount } },
//               { upsert: true, new: true }
//             );
//           }
//         }
//       }

//       lastBlock = currentBlock;
//     } catch (err) {
//       console.error("❌ Error in monitorBNBNative:", err);
//     }
//   }, 15_000);
// }
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



// === Monitor TRX Native Transfers ===
async function monitorTRXNative() {
  let lastBlock = await tronWeb.trx.getCurrentBlock();
  let lastBlockNum = lastBlock.block_header.raw_data.number;

  setInterval(async () => {
    try {
      const currentBlock = await tronWeb.trx.getCurrentBlock();
      const currentBlockNum = currentBlock.block_header.raw_data.number;

      for (let i = lastBlockNum + 1; i <= currentBlockNum; i++) {
        const block = await tronWeb.trx.getBlock(i);

        for (const tx of block.transactions || []) {
          const txRaw = tx.raw_data.contract[0].parameter.value;

          const toAddr = tronWeb.address.fromHex(txRaw.to_address);
          const fromAddr = tronWeb.address.fromHex(txRaw.owner_address);

          if (tronAddresses.includes(toAddr)) {
            const txInfo = await tronWeb.trx.getTransactionInfo(tx.txID);
            const amount = txRaw.amount / 1e6;

            console.log(`💰 Native TRX received: ${amount} TRX from ${fromAddr} to ${toAddr}`);

            await Transaction.create({
              chain: "tron",
              type: "deposit",
              symbol: "TRX",
              from: fromAddr,
              to: toAddr,
              amount,
              txHash: tx.txID,
            });

            await UserBalance.findOneAndUpdate(
              { address: fromAddr, chain: "tron", symbol: "TRX" },
              { $inc: { balance: amount } },
              { upsert: true, new: true }
            );
          }
        }
      }

      lastBlockNum = currentBlockNum;
    } catch (e) {
      console.error("❌ Error in monitorTRXNative:", e.message);
    }
  }, 15_000);
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

let lastSeenTxs = {};

async function monitorBTCNative() {
  console.log("🟡 BTC Monitor started (Testnet)");
  const BTC_POLL_MS = Number(process.env.BTC_POLL_MS || 30_000); // increase to 30s or more
  const axiosInstance = axios.create({ timeout: 20_000 });

  // small cache TTL map for addresses to avoid repeated heavy calls
  const addressBackoff = {};

  setInterval(async () => {
    for (const address of btcAddresses) {
      try {
        if (addressBackoff[address] && Date.now() < addressBackoff[address]) {
          // still backoff for this address
          continue;
        }

        const res = await axiosInstance.get(`https://blockstream.info/testnet/api/address/${address}/txs`);
        const txs = res.data;

        for (const tx of txs) {
          const txId = tx.txid;

          if (lastSeenTxs[address]?.includes(txId)) continue;

          for (const vout of tx.vout || []) {
            if (vout.scriptpubkey_address === address) {
              const amount = vout.value / 1e8;
              const from = tx.vin?.[0]?.prevout?.scriptpubkey_address || "unknown";

              console.log(`💰 Native BTC received: ${amount} BTC → ${address}`);

              await Transaction.create({
                chain: "bitcoin",
                type: "deposit",
                symbol: "BTC",
                from,
                to: address,
                amount,
                txHash: txId,
              });

              await UserBalance.findOneAndUpdate(
                { address: address, chain: "bitcoin", symbol: "BTC" },
                { $inc: { balance: amount } },
                { upsert: true, new: true }
              );
            }
          }

          if (!lastSeenTxs[address]) lastSeenTxs[address] = [];
          lastSeenTxs[address].push(txId);
          lastSeenTxs[address] = lastSeenTxs[address].slice(-50);
        }
      } catch (err) {
        console.error(`❌ Error checking BTC for address ${address}:`, err?.response?.status || err.message);

        // handle 429 specifically: backoff this address for some time
        if (err?.response?.status === 429) {
          // exponential backoff map
          addressBackoff[address] = Date.now() + (Number(process.env.BTC_BACKOFF_MS) || 60_000); // 1 minute default
          console.warn(`⚠️ 429 for ${address} — backing off for 60s`);
        } else {
          // for other transient errors, you can wait and try later
        }
      }
    }
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
    monitorSPL();
    monitorSOLNative();

    monitorETHNative();   // ETH
    monitorBNBNative();   // BNB
    monitorTRXNative();   // TRX
    monitorBTCNative();   //BTC
}
main();
