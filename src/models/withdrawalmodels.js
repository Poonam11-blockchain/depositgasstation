const mongoose = require("mongoose");

const withdrawalSchema = new mongoose.Schema({
  chain: String,
  symbol: String,
  from: String,
  to: String,
  amount: String,
  status: { type: String, default: "pending" }, // pending | approved | rejected | completed
  txHash: String,
  isApproved: { type: Boolean, default: false }, // add this line
  createdAt: { type: Date, default: Date.now },
  approvedAt: Date,
  executedAt: Date,
});

module.exports = mongoose.model("Withdrawal", withdrawalSchema);
