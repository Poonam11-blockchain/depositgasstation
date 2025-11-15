// // sweeper-full.js
// require("dotenv").config();
// const { ethers } = require("ethers");
// const TronWeb = require("tronweb");
// const fs = require("fs");
// const mongoose = require("mongoose");
// const bitcoin = require("bitcoinjs-lib");
// const axios = require("axios");
// const isForce = process.argv.includes("--force");

// const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, sendAndConfirmTransaction } = require("@solana/web3.js");
// const splToken = require("@solana/spl-token");
// const _bs58 = require("bs58");
// const bs58 = _bs58 && _bs58.default ? _bs58.default : _bs58;

// // ---------- Mongo ----------
// mongoose.set("strictQuery", false);
// mongoose
//   .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
//   .then(() => console.log("✅ Mongo connected"))
//   .catch((e) => {
//     console.error("Mongo connect error:", e.message);
//     process.exit(1);
//   });

// const Transaction = require("./src/models/transactionmodels");

// // ---------- CLI ----------
// const chain = process.argv[2]?.toLowerCase(); // 'ethereum' | 'bsc' | 'tron' | 'btc'
// if (!chain || !["ethereum", "bsc", "tron", "btc", "solana"].includes(chain)) {
//   console.error("❌ Please specify chain: ethereum | bsc | tron | btc | solana");
//   process.exit(1);
// }

// // ---------- Helpers ----------
// function isProbablyPrivateKey(pk) {
//   if (!pk || typeof pk !== "string") return false;
//   const s = pk.startsWith("0x") ? pk.slice(2) : pk;
//   return /^[0-9a-fA-F]{64}$/.test(s);
// }

// function maskKey(pk) {
//   if (!pk) return "undefined";
//   return pk.slice(0, 6) + "..." + pk.slice(-4);
// }

// // ---------- Run ----------
// (async () => {
//   try {
//     if (chain === "tron") {
//       await tronSweep();
//     } else if (chain === "btc") {
//       await btcSweep();
//     }else if (chain === "solana") {
//      await solanaSweep();
//     } else {
//       await evmSweep(chain); // ethereum/bsc
//     }
//   } catch (e) {
//     console.error("Fatal error:", e.stack || e.message);
//   } finally {
//     await mongoose.connection.close().catch(() => {});
//     process.exit(0);
//   }
// })();

// // ========================= EVM (ETH / BSC) =========================
// async function evmSweep(chainName) {
//   const erc20Abi = require("./erc20.json");
//   const users = require("./eth_wallets.json");
//   const tokens = require(chainName === "ethereum" ? "./tokenethereum.json" : "./tokenbsc.json");

//   const provider = new ethers.providers.JsonRpcProvider(
//     chainName === "ethereum" ? process.env.ETH_NODE_URL : process.env.BSC_NODE_URL
//   );

//   const destination = process.env.ADMIN_WALLET;
//   if (!destination) throw new Error("Missing ADMIN_WALLET in .env");

//   // Gas station (payer)
//   const GAS_PK = process.env.GAS_STATION_PRIVATE_KEY;
//   if (!GAS_PK) {
//     console.error("❌ Missing GAS_STATION_PRIVATE_KEY in .env (must control gas station address).");
//     process.exit(1);
//   }
//   if (!isProbablyPrivateKey(GAS_PK)) {
//     console.error("❌ GAS_STATION_PRIVATE_KEY does not look like a valid private key:", maskKey(GAS_PK));
//     process.exit(1);
//   }
//   let gasStation;
//   try {
//     gasStation = new ethers.Wallet(GAS_PK, provider);
//   } catch (e) {
//     console.error("❌ Failed to create gas station wallet:", e.message);
//     process.exit(1);
//   }
//   const gasStationAddr = await gasStation.getAddress();
//   console.log(`⛽ Using gas station: ${gasStationAddr}`);

//   const feeSymbol = chainName === "ethereum" ? "ETH" : "BNB";
//   const addBuffer20 = (bn) => bn.mul(12).div(10);

//   // ===== ERC-20 sweep with gas top-up =====
//   for (const tokenInfo of tokens) {
//     const token = new ethers.Contract(tokenInfo.address, erc20Abi, provider);
//     const userThreshold = ethers.utils.parseUnits("50", tokenInfo.decimals);
//     const exchangeThreshold = ethers.utils.parseUnits("100", tokenInfo.decimals);

//     let eligibleUsers = [];
//     let totalEligible = ethers.BigNumber.from(0);

//     for (const user of users) {
//       if (!user || !user.address) {
//         console.warn("⚠️ Skipping malformed user entry (missing address):", JSON.stringify(user));
//         continue;
//       }
//       if (!user.privateKey || !isProbablyPrivateKey(user.privateKey)) {
//         console.warn(`⚠️ Skipping ${user.address} — missing or invalid privateKey.`);
//         continue;
//       }

//       let bal;
//       try {
//         bal = await token.balanceOf(user.address);
//       } catch (e) {
//         console.error(`❌ Error reading ${tokenInfo.symbol} balance for ${user.address}: ${e.message}`);
//         continue;
//       }

//       if (bal.gte(userThreshold)) {
//         eligibleUsers.push({ ...user, balance: bal });
//         totalEligible = totalEligible.add(bal);
//       }
//     }

//     console.log(
//       `\n🔍 [${chainName.toUpperCase()}] Eligible ${tokenInfo.symbol}: ${ethers.utils.formatUnits(
//         totalEligible,
//         tokenInfo.decimals
//       )}`
//     );

//     if (totalEligible.lt(exchangeThreshold) && !isForce) {
//       console.log(`⛔ Skipping ${tokenInfo.symbol}: exchangeThreshold not met.`);
//       continue;
//     } else if (totalEligible.lt(exchangeThreshold) && isForce) {
//       console.log(`⚠️ Threshold not met, but --force enabled. Proceeding to sweep ${tokenInfo.symbol}...`);
//     }

//     for (const user of eligibleUsers) {
//       let userWallet;
//       try {
//         userWallet = new ethers.Wallet(user.privateKey, provider);
//       } catch (e) {
//         console.error(`❌ Invalid privateKey for ${user.address}: ${e.message}. Skipping.`);
//         continue;
//       }

//       try {
//         const gasPrice = await provider.getGasPrice();
//         let gasLimit;
//         try {
//           gasLimit = await token.connect(userWallet).estimateGas.transfer(destination, user.balance, {
//             from: user.address,
//           });
//         } catch {
//           gasLimit = ethers.BigNumber.from(90000);
//         }

//         const feeNeeded = addBuffer20(gasLimit.mul(gasPrice));
//         const userNativeBal = await provider.getBalance(user.address);

//         if (userNativeBal.lt(feeNeeded)) {
//           const topUp = feeNeeded.sub(userNativeBal);
//           try {
//             const fundTx = await gasStation.sendTransaction({ to: user.address, value: topUp });
//             console.log(
//               `⛽ Funded ${user.address} with ${ethers.utils.formatEther(topUp)} ${feeSymbol} (tx: ${fundTx.hash})`
//             );
//             await fundTx.wait();
//           } catch (fundErr) {
//             console.error(
//               `❌ Failed to top-up ${user.address} from gas station (${gasStationAddr}): ${fundErr.message}. Skipping user.`
//             );
//             continue;
//           }
//         }

//         const tx = await token.connect(userWallet).transfer(destination, user.balance, {
//           gasPrice,
//           gasLimit: addBuffer20(gasLimit),
//         });
//         console.log(`✅ ${tokenInfo.symbol} sweep from ${user.address}: ${tx.hash}`);
//         await tx.wait();

//         await Transaction.create({
//           type: "sweep",
//           chain: chainName,
//           symbol: tokenInfo.symbol,
//           from: user.address,
//           to: destination,
//           amount: user.balance.toString(),
//           txHash: tx.hash,
//           timestamp: new Date(),
//         });
//       } catch (err) {
//         console.error(`❌ Failed ${tokenInfo.symbol} from ${user.address}:`, err.message);
//       }
//     }
//   }

//   // ===== Native sweep (ETH/BNB) =====
//   let nativeTotal = ethers.BigNumber.from(0);
//   const nativeUsers = [];
//   for (const user of users) {
//     if (!user || !user.address) {
//       console.warn("⚠️ Skipping malformed user entry (missing address) in native sweep:", JSON.stringify(user));
//       continue;
//     }
//     if (!user.privateKey || !isProbablyPrivateKey(user.privateKey)) {
//       console.warn(`⚠️ Skipping native sweep for ${user.address} — missing or invalid privateKey.`);
//       continue;
//     }

//     try {
//       const bal = await provider.getBalance(user.address);
//       const gasLimit = ethers.BigNumber.from(21000);
//       const gasPrice = await provider.getGasPrice();
//       const txCost = gasLimit.mul(gasPrice);
//       if (bal.gt(txCost)) {
//         const sweepable = bal.sub(txCost);
//         nativeUsers.push({ ...user, sweepable, gasPrice });
//         nativeTotal = nativeTotal.add(sweepable);
//       } else if (!bal.isZero()) {
//         console.log(
//           `⚠️ ${user.address} insufficient for gas. Bal: ${ethers.utils.formatEther(bal)} ${feeSymbol}, Need: ${ethers.utils.formatEther(
//             txCost
//           )}`
//         );
//       }
//     } catch (e) {
//       console.error(`❌ Error fetching balance for ${user.address}: ${e.message}`);
//     }
//   }

//   console.log(`\n🔍 [${chainName.toUpperCase()}] Native total: ${ethers.utils.formatEther(nativeTotal)} ${feeSymbol}`);

//   for (const user of nativeUsers) {
//     let wallet;
//     try {
//       wallet = new ethers.Wallet(user.privateKey, provider);
//     } catch (e) {
//       console.error(`❌ Invalid privateKey for native sweep ${user.address}: ${e.message}. Skipping.`);
//       continue;
//     }
//     try {
//       const tx = await wallet.sendTransaction({
//         to: destination,
//         value: user.sweepable,
//         gasLimit: 21000,
//         gasPrice: user.gasPrice,
//       });
//       console.log(`✅ Swept native ${chainName} from ${user.address} => ${tx.hash}`);
//       await tx.wait();

//       await Transaction.create({
//         type: "sweep",
//         chain: chainName.toLowerCase(),
//         symbol: chainName.toUpperCase(),
//         from: user.address,
//         to: destination,
//         amount: ethers.utils.formatEther(user.sweepable),
//         txHash: tx.hash,
//         timestamp: new Date(),
//       });
//     } catch (err) {
//       console.error(`❌ Native sweep failed for ${user.address}: ${err.message}`);
//     }
//   }

//   console.log(`\n✅ All ${chainName.toUpperCase()} EVM sweeps completed.`);

//   // ===== ADMIN forward tokens if ≥ 2000 =====
//   const ADMIN_PK = process.env.ADMIN_WALLET_PRIVATE_KEY;
//   if (!ADMIN_PK || !isProbablyPrivateKey(ADMIN_PK)) {
//     console.warn("⚠️ ADMIN_WALLET_PRIVATE_KEY missing or invalid — skipping ADMIN->NEXT_MASTER forwarding.");
//     return;
//   }
//   const adminWallet = new ethers.Wallet(ADMIN_PK, provider);
//   const nextMaster = process.env.NEXT_MASTER_WALLET;

//   for (const tokenInfo of tokens) {
//     try {
//       const token = new ethers.Contract(tokenInfo.address, erc20Abi, provider);
//       const bal = await token.balanceOf(destination);
//       const threshold = ethers.utils.parseUnits("2000", tokenInfo.decimals);
//       if (bal.gte(threshold)) {
//         const tx = await token.connect(adminWallet).transfer(nextMaster, bal);
//         console.log(
//           `💸 Forwarded ${ethers.utils.formatUnits(bal, tokenInfo.decimals)} ${tokenInfo.symbol} → NEXT_MASTER: ${tx.hash}`
//         );
//         await tx.wait();
//       } else {
//         console.log(`${tokenInfo.symbol} in ADMIN (${ethers.utils.formatUnits(bal, tokenInfo.decimals)}) < 2000. Skip.`);
//       }
//     } catch (err) {
//       console.error(`❌ Forward ${tokenInfo.symbol} failed: ${err.message}`);
//     }
//   }
// }

// // ============================ TRON ============================
// async function tronSweep() {
//   const trc20Abi = require("./trc20.json");
//   const users = require("./tron_wallets.json");
//   const tokens = require("./tokentron.json");
//   const fullHost = process.env.TRON_NODE_URL;
//   if (!fullHost) throw new Error("Missing TRON_NODE_URL in .env");

//   const destination = process.env.ADMIN_WALLET_TRON;
//   const nextMasterTron = process.env.NEXT_MASTER_WALLET_TRON;
//   const adminTronPK = process.env.ADMIN_WALLET_PRIVATE_KEY_TRON;
//   if (!destination || !nextMasterTron || !adminTronPK) {
//     throw new Error("Missing TRON admin / next master envs");
//   }

//   // Optional separate tron gas station key. Default to adminTronPK if not set.
//   const TRON_GAS_PK = process.env.TRON_GAS_STATION_PRIVATE_KEY || adminTronPK;

//   const tronWebAdmin = new TronWeb({ fullHost, privateKey: adminTronPK });
//   const gasStationTron = new TronWeb({ fullHost, privateKey: TRON_GAS_PK });

//   // Constants
//   const MIN_TOPUP_SUN = 5_000_000; // ~5 TRX
//   const FEE_LIMIT = 50_000_000; // 50 TRX fee limit for TRC20 send

//   // ---------- Native TRX sweep ----------
//   for (const user of users) {
//     try {
//       const tronWebUser = new TronWeb({ fullHost, privateKey: user.privateKey });
//       const balanceSun = await tronWebUser.trx.getBalance(user.address);

//       let topupNeeded = 0;
//       if (balanceSun <= 0) topupNeeded = MIN_TOPUP_SUN;

//       if (topupNeeded > 0) {
//         try {
//           const txidTop = await gasStationTron.trx.sendTransaction(user.address, topupNeeded);
//           console.log(`⛽ TRON funded ${user.address} with ${(topupNeeded / 1e6).toFixed(6)} TRX: ${txidTop.txid}`);
//         } catch (e) {
//           console.error(`❌ Failed to fund ${user.address} on TRON: ${e.message}`);
//         }
//       }

//       const freshBal = await tronWebUser.trx.getBalance(user.address);
//       const sweepable = Math.max(0, freshBal - MIN_TOPUP_SUN);

//       if (sweepable > 0) {
//         const tx = await tronWebUser.trx.sendTransaction(destination, sweepable);
//         console.log(`✅ Swept TRX from ${user.address} => TxID: ${tx.txid}`);

//         await Transaction.create({
//           type: "sweep",
//           chain: "tron",
//           symbol: "TRX",
//           from: user.address,
//           to: destination,
//           amount: (sweepable / 1e6).toFixed(6),
//           txHash: tx.txid,
//           timestamp: new Date(),
//         });
//       } else {
//         console.log(`⚠️ ${user.address} has insufficient TRX to sweep.`);
//       }
//     } catch (err) {
//       console.error(`❌ Error sweeping TRX from ${user.address}: ${err.message}`);
//     }
//   }

//   // ---------- TRC-20 sweep ----------
//   for (const token of tokens) {
//     try {
//       const userThreshold = BigInt(50) * 10n ** BigInt(token.decimals);
//       const exchangeThreshold = BigInt(100) * 10n ** BigInt(token.decimals);

//       let totalEligible = 0n;
//       const eligible = [];

//       for (const user of users) {
//         try {
//           const tronWebUser = new TronWeb({ fullHost, privateKey: user.privateKey });
//           const tokenContract = await tronWebUser.contract(trc20Abi, token.address);
//           const balRaw = await tokenContract.methods.balanceOf(user.address).call();
//           const bal = BigInt(balRaw.toString());
//           if (bal >= userThreshold) {
//             totalEligible += bal;
//             eligible.push({ user, bal });
//           }
//         } catch (e) {
//           console.error(`❌ Error checking TRC20 ${token.symbol} for ${user.address}: ${e.message}`);
//         }
//       }

//       console.log(`\n🔍 [TRON] Eligible ${token.symbol}: ${Number(totalEligible) / 10 ** token.decimals}`);

//       if (totalEligible < exchangeThreshold && !isForce) {
//         console.log(`⛔ Skipping ${token.symbol}: exchange threshold not met.`);
//         continue;
//       } else if (totalEligible < exchangeThreshold && isForce) {
//         console.log(`⚠️ Threshold not met, but --force enabled. Proceeding to sweep ${token.symbol}...`);
//       }

//       for (const { user, bal } of eligible) {
//         try {
//           const tronWebUser = new TronWeb({ fullHost, privateKey: user.privateKey });
//           const tokenContract = await tronWebUser.contract(trc20Abi, token.address);

//           const currSun = await tronWebUser.trx.getBalance(user.address);
//           if (currSun < MIN_TOPUP_SUN) {
//             const addSun = MIN_TOPUP_SUN - currSun + 500000; // +0.5 TRX slack
//             try {
//               const txidTop = await gasStationTron.trx.sendTransaction(user.address, addSun);
//               console.log(`⛽ TRON funded ${user.address} with ${(addSun / 1e6).toFixed(6)} TRX: ${txidTop.txid}`);
//             } catch (e) {
//               console.error(`❌ Failed to fund ${user.address} before TRC20 transfer: ${e.message}`);
//               continue;
//             }
//           }

//           const tx = await tokenContract.methods.transfer(destination, bal.toString()).send({ feeLimit: FEE_LIMIT });
//           console.log(`✅ TRC20 ${token.symbol} from ${user.address} => TxID: ${tx}`);

//           await Transaction.create({
//             type: "sweep",
//             chain: "tron",
//             symbol: token.symbol,
//             from: user.address,
//             to: destination,
//             amount: bal.toString(),
//             txHash: tx,
//             timestamp: new Date(),
//           });
//         } catch (err) {
//           console.error(`❌ Failed ${token.symbol} from ${user.address}: ${err.message}`);
//         }
//       }
//     } catch (err) {
//       console.error(`❌ Token loop error (${token.symbol}): ${err.message}`);
//     }
//   }

//   console.log("\n✅ All TRON sweeps completed.\n");

//   // ---------- Admin forward TRON tokens if ≥ 2000 ----------
//   for (const token of tokens) {
//     try {
//       const tokenContract = await tronWebAdmin.contract(trc20Abi, token.address);
//       const balRaw = await tokenContract.methods.balanceOf(destination).call();
//       const bal = BigInt(balRaw.toString());
//       const threshold = BigInt(2000) * 10n ** BigInt(token.decimals);

//       if (bal >= threshold) {
//         const tx = await tokenContract.methods.transfer(nextMasterTron, bal.toString()).send({ feeLimit: 20_000_000 });
//         console.log(`💸 Forwarded ${Number(bal) / 10 ** token.decimals} ${token.symbol} from ADMIN to NEXT_MASTER: ${tx}`);
//       } else {
//         console.log(`⛔ Skipping ${token.symbol} forward: Balance ${Number(bal) / 10 ** token.decimals} < 2000`);
//       }
//     } catch (err) {
//       console.error(`❌ Error forwarding ${token.symbol}: ${err.message}`);
//     }
//   }
// }

// // ============================ BTC ============================
// async function btcSweep() {
//   const { ECPairFactory } = require("ecpair");
//   const tinysecp = require("tiny-secp256k1");
//   const ECPair = ECPairFactory(tinysecp);

//   const NETWORK = process.env.BTC_MAINNET === "1" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
//   const DESTINATION_ADDRESS = process.env.ADMIN_WALLET_BTC;
//   if (!DESTINATION_ADDRESS) throw new Error("Missing ADMIN_WALLET_BTC in .env");

//   const wallets = require("./btc_wallets.json");

//   async function fetchUTXOs(address) {
//     const url = NETWORK === bitcoin.networks.bitcoin
//       ? `https://mempool.space/api/address/${address}/utxo`
//       : `https://mempool.space/testnet/api/address/${address}/utxo`;
//     const res = await axios.get(url);
//     return res.data;
//   }

//   async function broadcastTx(rawTx) {
//     try {
//       const url = NETWORK === bitcoin.networks.bitcoin
//         ? "https://mempool.space/api/tx"
//         : "https://mempool.space/testnet/api/tx";
//       const res = await axios.post(url, rawTx, { headers: { "Content-Type": "text/plain" } });
//       return res.data;
//     } catch (error) {
//       console.error("❌ Broadcast failed:", error.response?.data || error.message);
//       throw error;
//     }
//   }

//   for (const wallet of wallets) {
//     try {
//       if (!wallet.privateKey) {
//         console.warn("⚠️ Skipping BTC wallet missing privateKey:", JSON.stringify(wallet));
//         continue;
//       }

//       const keyPair = ECPair.fromWIF(wallet.privateKey, NETWORK);
//       const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK });

//       const utxos = await fetchUTXOs(address);
//       if (!utxos || utxos.length === 0) {
//         console.log(`❌ No UTXOs for ${address}`);
//         continue;
//       }

//       const psbt = new bitcoin.Psbt({ network: NETWORK });
//       let totalInput = 0;

//       for (const utxo of utxos) {
//         psbt.addInput({
//           hash: utxo.txid,
//           index: utxo.vout,
//           witnessUtxo: {
//             script: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: NETWORK }).output,
//             value: utxo.value,
//           },
//         });
//         totalInput += utxo.value;
//       }

//       // static fee (sats) — replace with estimator if desired
//       const fee = parseInt(process.env.BTC_STATIC_FEE || "178", 10);
//       if (totalInput <= fee) {
//         console.log(`⚠️ Skipping ${address}, balance too low to cover fee.`);
//         continue;
//       }

//       psbt.addOutput({ address: DESTINATION_ADDRESS, value: totalInput - fee });
//       psbt.signAllInputs(keyPair);
//       psbt.validateSignaturesOfAllInputs((pubkey, msghash, signature) => tinysecp.verify(msghash, pubkey, signature));
//       psbt.finalizeAllInputs();

//       const tx = psbt.extractTransaction();
//       const txHex = tx.toHex();
//       const txid = await broadcastTx(txHex);

//       console.log(`✅ Swept ${address} → ${DESTINATION_ADDRESS}: ${txid}`);

//       await Transaction.create({
//         type: "sweep",
//         chain: "btc",
//         symbol: "BTC",
//         from: address,
//         to: DESTINATION_ADDRESS,
//         amount: (totalInput - fee) / 1e8,
//         txHash: txid,
//         timestamp: new Date(),
//       });
//     } catch (e) {
//       console.error(`❌ Error sweeping BTC wallet:`, e.stack || e.message);
//     }
//   }

//   console.log("\n✅ All BTC sweeps completed.\n");
// }


// // ------------------------ SOLANA ------------------------
// function loadSolKey(key) {
//   // Accept either base58 string or JSON array of numbers
//   if (!key) return null;
//   if (Array.isArray(key)) return Keypair.fromSecretKey(Uint8Array.from(key));
//   try {
//     // try parse JSON array
//     const maybe = JSON.parse(key);
//     if (Array.isArray(maybe)) return Keypair.fromSecretKey(Uint8Array.from(maybe));
//   } catch (e) {}
//   // treat as base58
//   try {
//     const raw = bs58.decode(key);
//     return Keypair.fromSecretKey(Uint8Array.from(raw));
//   } catch (e) {
//     throw new Error("Invalid Solana private key format. Provide base58 or JSON array.");
//   }
// }

// async function solanaSweep() {
//   const users = require("./user_walletsfinalmultichain.json");
//   const tokens = require("./tokensolana.json"); // SPL token mints
//   const rpc = process.env.SOLANA_RPC_URL;
//   if (!rpc) throw new Error("Missing SOLANA_RPC_URL in .env");
//   const connection = new Connection(rpc, "confirmed");

//   const destination = process.env.ADMIN_WALLET_SOL;
//   if (!destination) throw new Error("Missing ADMIN_WALLET_SOL in .env");

//   // gas station / admin key
//   const GAS_KEY_RAW = process.env.SOL_GAS_STATION_PRIVATE_KEY || process.env.ADMIN_WALLET_PRIVATE_KEY_SOL;
//   if (!GAS_KEY_RAW) {
//     console.error("❌ Missing SOL_GAS_STATION_PRIVATE_KEY or ADMIN_WALLET_PRIVATE_KEY_SOL in .env");
//     process.exit(1);
//   }
//   const gasKeypair = loadSolKey(GAS_KEY_RAW);
//   const gasPub = gasKeypair.publicKey.toBase58();
//   console.log(`⛽ Using Solana gas station: ${gasPub}`);

//   // Helper: ensure user Keypair
//   function kpFromUser(user) {
//     if (!user.privateKey) throw new Error("user missing privateKey");
//     return loadSolKey(user.privateKey);
//   }

//   // --- SPL token checks: build map of token mint => decimals
//   const tokenInfoMap = {};
//   for (const t of tokens) {
//     tokenInfoMap[t.address] = t;
//   }

//   // ===== SPL token sweep =====
//   for (const token of tokens) {
//     // skip native SOL entry if included as a token; we'll handle native separately
//     const mintPub = new PublicKey(token.address);
//     const tokenDecimals = token.decimals ?? 9;

//     let totalEligible = 0n;
//     const eligible = [];
// // ===== SPL token sweep =====
//   for (const token of tokens) {
//     // basic validation & skip placeholders
//     if (!token || !token.address || typeof token.address !== "string") {
//       console.warn("⚠️ Skipping token entry missing/invalid address:", JSON.stringify(token));
//       continue;
//     }
//     const addrTrim = token.address.trim();
//     if (addrTrim.length === 0 || addrTrim.toUpperCase() === "SOL" || addrTrim.toLowerCase() === "native") {
//       console.log(`ℹ️ Skipping token with placeholder address "${token.address}"`);
//       continue;
//     }

//     let mintPub;
//     try {
//       mintPub = new PublicKey(addrTrim);
//     } catch (err) {
//       console.warn(`⚠️ Invalid token mint address for ${token.symbol || token.address} — skipping: ${token.address}`);
//       continue;
//     }

//     const tokenDecimals = token.decimals ?? 9;

//     let totalEligible = 0n;
//     const eligible = [];

//     for (const user of users) {
//       if (!user || !user.address || !user.privateKey) continue;

//       // validate user.address before creating PublicKey
//       let owner;
//       try {
//         owner = new PublicKey(user.address);
//       } catch (err) {
//         console.warn(`⚠️ Skipping user with invalid Solana address: ${JSON.stringify(user)}`);
//         continue;
//       }

//       try {
//         // fetch parsed token accounts for this mint
//         const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPub });
//         let balanceRaw = 0n;
//         for (const acc of resp.value) {
//           const amt = acc.account.data.parsed.info.tokenAmount;
//           if (amt && amt.amount) {
//             balanceRaw += BigInt(amt.amount);
//           }
//         }
//         const userThreshold = BigInt(50) * 10n ** BigInt(tokenDecimals);
//         if (balanceRaw >= userThreshold) {
//           totalEligible += balanceRaw;
//           eligible.push({ user, balance: balanceRaw });
//         }
//       } catch (err) {
//         console.error(`❌ Error checking SPL ${token.symbol || addrTrim} for ${user.address}: ${err.message}`);
//       }
//     }
//   }

//     console.log(`\n🔍 [SOLANA] Eligible ${token.symbol}: ${Number(totalEligible) / 10 ** token.decimals || token.decimals}`);

//     const exchangeThreshold = BigInt(100) * 10n ** BigInt(token.decimals);
//     if (totalEligible < exchangeThreshold && !isForce) {
//       console.log(`⛔ Skipping ${token.symbol}: exchange threshold not met.`);
//       continue;
//     } else if (totalEligible < exchangeThreshold && isForce) {
//       console.log(`⚠️ Threshold not met, but --force enabled. Proceeding...`);
//     }

//     for (const { user, balance } of eligible) {
//       try {
//         const userKp = kpFromUser(user);
//         const userPub = userKp.publicKey;
//         // Ensure user has enough lamports to pay for transaction fees and possible ATA creation for destination
//         const minNeeded = Math.ceil(0.001 * LAMPORTS_PER_SOL); // small buffer (~0.001 SOL)
//         const userLamports = await connection.getBalance(userPub);
//         if (userLamports < minNeeded) {
//           const topUp = minNeeded - userLamports;
//           const topTx = new Transaction().add(
//             SystemProgram.transfer({
//               fromPubkey: gasKeypair.publicKey,
//               toPubkey: userPub,
//               lamports: topUp,
//             })
//           );
//           const sig = await sendAndConfirmTransaction(connection, topTx, [gasKeypair]);
//           console.log(`⛽ Funded ${user.address} with ${topUp / LAMPORTS_PER_SOL} SOL (tx: ${sig})`);
//         }

//         // ensure destination has associated token account (ATA)
//         const destPub = new PublicKey(destination);
//         const destATA = await splToken.getAssociatedTokenAddress(mintPub, destPub);
//         const destATAInfo = await connection.getAccountInfo(destATA);
//         const instructions = [];

//         if (!destATAInfo) {
//           // create ATA using gasKeypair as payer (or user as payer if user has lamports)
//           instructions.push(
//             splToken.createAssociatedTokenAccountInstruction(
//               gasKeypair.publicKey, // payer (gas station will pay)
//               destATA,
//               destPub,
//               mintPub
//             )
//           );
//         }

//         // find user's ATA for this mint
//         const userATA = await splToken.getAssociatedTokenAddress(mintPub, userPub);
//         // transfer instruction
//         instructions.push(
//           splToken.createTransferInstruction(userATA, destATA, userPub, BigInt(balance), [])
//         );

//         const tx = new Transaction().add(...instructions);
//         // If we used gasKeypair to create ATA (payer) then we must sign with gasKeypair & userKp.
//         // We'll sign with both: user signs the transfer; gasKey signs ATA creation if present.
//         const signers = [userKp];
//         if (!destATAInfo) signers.push(gasKeypair);

//         const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
//         console.log(`✅ SPL ${token.symbol} swept from ${user.address}: ${sig}`);

//         await Transaction.create({
//           type: "sweep",
//           chain: "solana",
//           symbol: token.symbol,
//           from: user.address,
//           to: destination,
//           amount: balance.toString(),
//           txHash: sig,
//           timestamp: new Date(),
//         });
//       } catch (err) {
//         console.error(`❌ Failed ${token.symbol} from ${user.address}: ${err.message}`);
//       }
//     }
//   }

//   // ===== Native SOL sweep =====
//  // ===== Native SOL sweep (improved logging & BigInt-safe) =====
// let nativeTotal = 0n;
// const nativeUsers = [];

// for (const user of users) {
//   if (!user || !user.address || !user.privateKey) continue;

//   try {
//     // derive keypair and public key
//     const kp = kpFromUser(user);
//     const derived = kp.publicKey.toBase58();
//     if (derived !== user.address) {
//       console.warn(`⚠️ Address/privateKey mismatch: file.address=${user.address} derived=${derived} — using derived pubkey.`);
//     }

//     // get balance (Number) then convert to BigInt
//     const lamNumber = await connection.getBalance(kp.publicKey, "confirmed");
//     const lam = BigInt(Math.floor(lamNumber)); // BigInt lamports

//     // print address + balance (human-friendly)
//     const solBalance = Number(lam) / Number(LAMPORTS_PER_SOL);
//     console.log(`👛 User: ${derived} | Balance: ${solBalance.toFixed(6)} SOL`);

//     // fee buffer (BigInt)
//     const feeBuffer = BigInt(Math.ceil(0.001 * LAMPORTS_PER_SOL));

//     if (lam > feeBuffer) {
//       const sweepable = lam - feeBuffer;
//       nativeUsers.push({ user, sweepable, kp });
//       nativeTotal = nativeTotal + sweepable;
//     } else if (lam > 0n) {
//       console.log(`⚠️ ${derived} insufficient for gas. Bal: ${(Number(lam) / Number(LAMPORTS_PER_SOL)).toFixed(6)} SOL`);
//     }
//   } catch (e) {
//     console.error(`❌ Error fetching SOL balance for ${user.address}: ${e.message}`);
//   }
// }

// console.log(`\n🔍 [SOLANA] Native total: ${(Number(nativeTotal) / Number(LAMPORTS_PER_SOL)).toFixed(9)} SOL\n`);

// // Sweep native users
// for (const { user, sweepable, kp } of nativeUsers) {
//   try {
//     // build & send transfer (convert BigInt -> Number for lamports)
//     const lamportsNumber = Number(sweepable); // safe for practical balances
//     const tx = new Transaction().add(
//       SystemProgram.transfer({
//         fromPubkey: kp.publicKey,
//         toPubkey: new PublicKey(destination),
//         lamports: lamportsNumber,
//       })
//     );
//     const sig = await sendAndConfirmTransaction(connection, tx, [kp], { commitment: "confirmed" });
//     console.log(`✅ Swept native SOL from ${kp.publicKey.toBase58()} => ${sig}`);

//     // save record to DB (use TxModel to avoid name collision)
//     await Transaction.create({
//       type: "sweep",
//       chain: "solana",
//       symbol: "SOL",
//       from: kp.publicKey.toBase58(),
//       to: destination,
//       amount: (Number(sweepable) / Number(LAMPORTS_PER_SOL)).toString(),
//       txHash: sig,
//       timestamp: new Date(),
//     });
//   } catch (err) {
//     console.error(`❌ Native sweep failed for ${user.address}: ${err.message}`);
//   }
// }


//   // ===== ADMIN forward SOL/tokens if >= threshold (example for SOL) =====
//  try {
//   const adminKey = loadSolKey(process.env.ADMIN_WALLET_PRIVATE_KEY_SOL);
//   if (!adminKey) {
//     console.warn("⚠️ ADMIN_WALLET_PRIVATE_KEY_SOL not provided; skipping admin forward check.");
//   } else {
//     // get admin balance as Number, then convert to BigInt for safe arithmetic
//     const adminBalanceNumber = await connection.getBalance(adminKey.publicKey);
//     const adminBalance = BigInt(adminBalanceNumber); // now BigInt

//     // threshold expressed in lamports (BigInt)
//     const forwardThresholdLamports = BigInt(Math.ceil((process.env.SOL_FORWARD_THRESHOLD_SOL ? Number(process.env.SOL_FORWARD_THRESHOLD_SOL) : 2000) * LAMPORTS_PER_SOL));

//     // diagnostic
//     console.log("🔎 ADMIN balance (SOL):", Number(adminBalance) / Number(LAMPORTS_PER_SOL));
//     console.log("🔎 Forward threshold (SOL):", Number(forwardThresholdLamports) / Number(LAMPORTS_PER_SOL));

//     if (adminBalance >= forwardThresholdLamports) {
//       // compute amount to forward leaving 1 SOL buffer (BigInt)
//       const bufferLamports = 1n * BigInt(LAMPORTS_PER_SOL);
//       const forwardLamports = adminBalance - bufferLamports;
//       if (forwardLamports <= 0n) {
//         console.log("ℹ️ Admin balance only equals buffer; nothing to forward.");
//       } else {
//         const nextMaster = process.env.NEXT_MASTER_WALLET_SOL;
//         if (!nextMaster) {
//           console.warn("⚠️ NEXT_MASTER_WALLET_SOL not set; cannot forward.");
//         } else {
//           // build transfer (SystemProgram.transfer expects Number lamports)
//           const lamportsNumber = Number(forwardLamports); // convert back to Number (safe for typical balances below ~9e15 lamports)
//           const tx = new Transaction().add(
//             SystemProgram.transfer({
//               fromPubkey: adminKey.publicKey,
//               toPubkey: new PublicKey(nextMaster),
//               lamports: lamportsNumber,
//             })
//           );
//           const sig = await sendAndConfirmTransaction(connection, tx, [adminKey], { commitment: "confirmed" });
//           console.log(`💸 Forwarded SOL from ADMIN to NEXT_MASTER: ${sig}`);
//         }
//       }
//     } else {
//       console.log("🚫 ADMIN SOL < threshold; skip forward.");
//     }
//   }
// } catch (e) {
//   console.warn("⚠️ Admin forward check failed:", e.message || e);
// }
// }

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
  const erc20Abi = require("./erc20.json");
  const usersPath = chainName === "ethereum" ? "./eth_wallets.json" : "./bsc_wallets.json";
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

  // Native TRX sweep
  for (const user of users) {
    try {
      if (!user.privateKey) continue;
      const tronWebUser = new TronWeb({ fullHost, privateKey: user.privateKey });
      const balanceSun = await tronWebUser.trx.getBalance(user.address);
      const MIN_TOPUP_SUN = 5_000_000; // ~5 trx
      let topupNeeded = 0;
      if (balanceSun <= 0) topupNeeded = MIN_TOPUP_SUN;
      if (topupNeeded > 0) {
        try {
          const txidTop = await gasStationTron.trx.sendTransaction(user.address, topupNeeded);
          console.log(`TRON funded ${user.address} with ${(topupNeeded / 1e6).toFixed(6)} TRX: ${txidTop.txid}`);
        } catch (e) {
          console.error(`Failed to fund ${user.address} on TRON: ${e.message}`);
        }
      }

      const freshBal = await tronWebUser.trx.getBalance(user.address);
      const sweepable = Math.max(0, freshBal - 5_000_000);
      if (sweepable > 0) {
        const tx = await tronWebUser.trx.sendTransaction(destination, sweepable);
        console.log(`Swept TRX from ${user.address} => TxID: ${tx.txid}`);
        await TransactionModel.create({
          type: "sweep",
          chain: "tron",
          symbol: "TRX",
          from: user.address,
          to: destination,
          amount: (sweepable / 1e6).toFixed(6),
          txHash: tx.txid,
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error(`Error sweeping TRX from ${user.address}: ${err.message}`);
    }
  }

  // TRC-20 loop
  for (const token of tokens) {
    try {
      const userThreshold = BigInt(50) * 10n ** BigInt(token.decimals);
      const exchangeThreshold = BigInt(100) * 10n ** BigInt(token.decimals);

      let totalEligible = 0n;
      const eligible = [];
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
          console.error(`Error checking TRC20 ${token.symbol} for ${user.address}: ${e.message}`);
        }
      }

      if (totalEligible < exchangeThreshold && !isForce) {
        console.log(`Skipping ${token.symbol}: threshold not met`);
        continue;
      }

      for (const { user, bal } of eligible) {
        try {
          const tronWebUser = new TronWeb({ fullHost, privateKey: user.privateKey });
          const tokenContract = await tronWebUser.contract(trc20Abi, token.address);

          const currSun = await tronWebUser.trx.getBalance(user.address);
          if (currSun < 5_000_000) {
            const addSun = 5_000_000 - currSun + 500000;
            try {
              await gasStationTron.trx.sendTransaction(user.address, addSun);
            } catch (e) {
              console.error(`Failed to fund ${user.address} before TRC20 transfer: ${e.message}`);
              continue;
            }
          }

          const tx = await tokenContract.methods.transfer(destination, bal.toString()).send({ feeLimit: 50_000_000 });
          console.log(`TRC20 ${token.symbol} from ${user.address} => TxID: ${tx}`);
          await TransactionModel.create({
            type: "sweep",
            chain: "tron",
            symbol: token.symbol,
            from: user.address,
            to: destination,
            amount: bal.toString(),
            txHash: tx,
            timestamp: new Date(),
          });
        } catch (err) {
          console.error(`Failed ${token.symbol} from ${user.address}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`Token loop error: ${err.message}`);
    }
  }

  // Admin forward TRC20 if threshold (optional) - omitted heavy logic for brevity, reuse pattern from above.

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
    if (!chain || !["ethereum","bsc","tron","btc","solana"].includes(chain)) {
      return res.status(400).json({ error: "chain required: ethereum|bsc|tron|btc|solana" });
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

