require("dotenv").config();
const mongoose = require("mongoose");
const { ethers } = require("ethers");
const TronWeb = require("tronweb");

const Withdrawal = require("./src/models/withdrawalmodels");
const Transaction = require("./src/models/transactionmodels");
const UserBalance = require("./src/models/userBalancemodels");


const MONGO_URI = process.env.MONGO_URI;

(async () => {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ MongoDB connected");

    const rawWithdrawals = await Withdrawal.find({ isApproved: false });

    const pendingWithdrawals = rawWithdrawals.filter(w => parseFloat(w.amount) >= 50);

    if (!pendingWithdrawals.length) {
      console.log("⚠️ No pending large withdrawals found.");
      return;
    }

    for (const withdrawal of pendingWithdrawals) {
      const { _id, chain, symbol, to, amount } = withdrawal;

      console.log(`🔍 Approving withdrawal ${_id} - ${amount} ${symbol} to ${to} on ${chain}`);

      // Step 1: Mark as approved
      await Withdrawal.findByIdAndUpdate(_id, { isApproved: true });

      try {
        // Step 2: Trigger the actual withdrawal on chain
        if (chain === "tron") {
          if (symbol === "TRX") {
            await tronNativeWithdraw(to, amount);
          } else {
            await tronWithdraw(symbol, to, amount);
          }
        } else {
          if (symbol === "ETH" || symbol === "BNB") {
            await evmNativeWithdraw(chain, symbol, to, amount);
          } else {
            await evmWithdraw(chain, symbol, to, amount);
          }
        }

        // Step 3: Mark as completed
        await Withdrawal.findByIdAndUpdate(_id, { status: "completed" });
        const normalizedTo = chain === "tron" ? to : to.toLowerCase();
        // Step 4: Deduct from user balance
        await UserBalance.findOneAndUpdate(
          { address: normalizedTo, chain, symbol },
          { $inc: { balance: -parseFloat(amount) } }
        );


        console.log(`✅ Withdrawal ${_id} processed & balance updated.`);

      } catch (err) {
        console.error(`❌ Failed to process withdrawal ${_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 MongoDB disconnected");
  }
})();

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
    token: symbol,
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
      token: symbol,
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