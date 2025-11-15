// utils/balanceChecker.js
const Transaction = require('../src/models/transactionmodels');
const Withdrawal = require('../src/models/withdrawalmodels');

async function getUserTokenBalance(userAddress, chain, tokenSymbol) {
  const deposits = await Transaction.aggregate([
    { $match: { to: userAddress, chain: chain.toLowerCase(), symbol: tokenSymbol.toUpperCase(), transaction_type: 'deposit', status: 'success' } },
    { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } }
  ]);

  const withdrawals = await Withdrawal.aggregate([
    { $match: { to: userAddress, chain: chain.toLowerCase(), symbol: tokenSymbol.toUpperCase(), status: 'success' } },
    { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } } } }
  ]);

  const totalDeposits = deposits[0]?.total || 0;
  const totalWithdrawals = withdrawals[0]?.total || 0;

  return totalDeposits - totalWithdrawals;
}

module.exports = getUserTokenBalance;
