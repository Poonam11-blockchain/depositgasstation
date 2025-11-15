const mongoose = require("mongoose");

const userBalanceSchema = new mongoose.Schema({
    address: { type: String, required: true },
    chain: { type: String, required: true },
    symbol: { type: String, required: true },
    balance: { type: Number, default: 0 },
}, { timestamps: true });

userBalanceSchema.index({ address: 1, chain: 1, symbol: 1 }, { unique: true });

module.exports = mongoose.model("UserBalance", userBalanceSchema);
