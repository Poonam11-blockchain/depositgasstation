const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ["deposit", "sweep", "withdrawal"], required: true },
  chain: String,
  symbol: String,
  from: String,
  to: String,
  amount: String,
  txHash: String,
  timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Transaction", transactionSchema);
