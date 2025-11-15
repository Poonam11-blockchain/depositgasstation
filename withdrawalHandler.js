require("dotenv").config();
const { ethers } = require("ethers");
const TronWeb = require("tronweb");
const mongoose = require("mongoose");

const Transaction = require("./src/models/transactionmodels");
const Withdrawal = require("./src/models/withdrawalmodels");
const UserBalance = require("./src/models/userBalancemodels");

const ERC20_ABI = require("./erc20.json");
const TRC20_ABI = require("./trc20.json");
const [,, chainArg, symbolArg, toAddress, amountRaw] = process.argv;

const chain = chainArg?.toLowerCase();
const symbol = symbolArg?.toUpperCase();

if (!chain || !["ethereum", "bsc", "tron", "bitcoin"].includes(chain)) {
  console.error("❌ Usage: node withdrawalHandler.js <ethereum|bsc|tron|btc> <TOKEN> <to> <amount>");
  process.exit(1);
}

if (!symbol || !toAddress || !amountRaw) {
  console.error("❌ Please provide symbol, recipient, and amount");
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ MongoDB connected");
  

    const amount = parseFloat(amountRaw);
    // const normalizedTo = toAddress.toLowerCase();
const normalizedTo = chain === "tron" ? toAddress : toAddress.toLowerCase();
 if (chain === "btc" && symbol === "BTC") {
  const axios = require("axios");
  const data = await axios.get(`https://blockstream.info/testnet/api/address/${normalizedTo}`);
  const sats = data.data.chain_stats.funded_txo_sum - data.data.chain_stats.spent_txo_sum;
  const balance = sats / 1e8;
  await UserBalance.findOneAndUpdate(
    { address: normalizedTo, chain, symbol },
    { $set: { balance } },
    { upsert: true }
  );
}
const userBalance = await UserBalance.findOne({ address: normalizedTo, chain, symbol });

    if (!userBalance || userBalance.balance < amount) {
      console.error("❌ Insufficient balance in database");
      return;
    }

    const isAutoApproved = amount < 50;

    const withdrawal = await Withdrawal.create({
      chain,
      symbol,
      to: normalizedTo,
      amount,
      status: isAutoApproved ? "pending" : "pending",
      isApproved: isAutoApproved,
    });

    console.log(`📝 Withdrawal request logged: ${withdrawal._id}`);

    if (!isAutoApproved) {
      console.log("🛡️ Awaiting multi-sig approval");
      return;
    }

    if (chain === "tron") {
  if (symbol === "TRX") {
    await tronNativeWithdraw(normalizedTo, amount);
  } else {
    await tronWithdraw(symbol, normalizedTo, amount);
  }

} else if (chain === "bitcoin") {
  // Handle BTC withdrawal
  await btcWithdraw(symbol, normalizedTo, amount);

} else {
  if (symbol === "ETH" || symbol === "BNB") {
    await evmNativeWithdraw(chain, symbol, normalizedTo, amount);
  } else {
    await evmWithdraw(chain, symbol, normalizedTo, amount);
  }
}

    await Withdrawal.findByIdAndUpdate(withdrawal._id, { status: "completed" });
    await UserBalance.findOneAndUpdate(
      { address: normalizedTo, chain, symbol },
      { $inc: { balance: -amount } }
    );

    console.log("✅ Balance updated & withdrawal completed.");
  } catch (err) {
    console.error("❌ Error:", err.message || err);
  } finally {
    await mongoose.disconnect();
  }
})();


async function evmWithdraw(chain, symbol, to, amountRaw) {
  const tokens = require(`./token${chain}.json`);
  const tokenInfo = tokens.find(t => t.symbol === symbol);
  if (!tokenInfo) {
    console.error(`❌ ${symbol} not configured in token${chain}.json`);
    return;
  }

  const provider = new ethers.providers.JsonRpcProvider(
    chain === "ethereum" ? process.env.ETH_NODE_URL : process.env.BSC_NODE_URL
  );

  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS);
  const mainAdminWallet = new ethers.Wallet(adminKeys[0], provider);
  const token = new ethers.Contract(tokenInfo.address, ERC20_ABI, mainAdminWallet);
  const amount = ethers.utils.parseUnits(amountRaw, tokenInfo.decimals);

  // Check if Admin1 has enough
  let mainBalance = await token.balanceOf(mainAdminWallet.address);
  if (mainBalance.lt(amount)) {
    console.log("Admin1 has insufficient funds, attempting refill");

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
      console.error("❌ Refill failed. Not enough funds in fallback admins.");
      return;
    }
  }

  // Proceed with withdrawal
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

////native currency ETH/BNB

async function 
evmNativeWithdraw(chain, symbol, to, amount) {
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

// =============== TRC20 TOKEN WITHDRAWAL WITH REFILL ===============

const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS_TRON); // [pk1, pk2, pk3...]

function getTronWeb(privateKey) {
  return new TronWeb({
    fullHost: process.env.TRON_NODE_URL,
    privateKey,
  });
}
async function tronWithdraw(symbol, to, amountRaw) {
  const tokens = require("./tokentron.json");
  const tokenInfo = tokens.find(t => t.symbol === symbol);
  if (!tokenInfo) return console.error(`Token ${symbol} not found in config`);

  const mainTronWeb = getTronWeb(adminKeys[0]);
  const contract = await mainTronWeb.contract(TRC20_ABI, tokenInfo.address);
  const amount = BigInt(parseFloat(amountRaw) * 10 ** tokenInfo.decimals).toString();

  const mainAdmin = mainTronWeb.address.fromPrivateKey(adminKeys[0]);
  const mainBalance = await contract.methods.balanceOf(mainAdmin).call();

  if (BigInt(mainBalance) < BigInt(amount)) {
    console.log(`Main admin TRC20 balance low. Trying refill...`);
    for (let i = 1; i < adminKeys.length; i++) {
      const fallbackWeb = getTronWeb(adminKeys[i]);
      const fallbackAddr = fallbackWeb.address.fromPrivateKey(adminKeys[i]);
      const fallbackContract = await fallbackWeb.contract(TRC20_ABI, tokenInfo.address);
      const fallbackBalance = await fallbackContract.methods.balanceOf(fallbackAddr).call();

      if (BigInt(fallbackBalance) >= BigInt(amount)) {
        await fallbackContract.methods.transfer(mainAdmin, amount).send({ feeLimit: 15_000_000 });
        console.log(`Refilled ${symbol} from Admin${i + 1}`);
        break;
      }
    }
  }

  // Retry balance check
  const finalBalance = await contract.methods.balanceOf(mainAdmin).call();
  if (BigInt(finalBalance) < BigInt(amount)) {
    return console.error("Insufficient funds even after refill.");
  }

  // Proceed with token transfer
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


async function btcWithdraw(symbol, to, amountRaw) {
  const bitcoin = require("bitcoinjs-lib");
  const axios = require("axios");
  const { ECPairFactory } = require("ecpair");
  const tinysecp = require("tiny-secp256k1");

  const ECPair = ECPairFactory(tinysecp);
  const NETWORK = bitcoin.networks.testnet;
  const satsPerByte = 2;

  const adminKeys = JSON.parse(process.env.ADMIN_WALLETS_PRIVATE_KEYS_BTC);
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

      // Don't break here yet - need all inputs to estimate real size accurately
    }

    const inputsCount = psbt.inputCount;
    const estimatedFee = estimateFee(inputsCount, 2, satsPerByte); // 2 outputs: to + change
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

  console.error("❌ All admin BTC wallets have insufficient funds.");
}


