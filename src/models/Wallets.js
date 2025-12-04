// models/Address.js
const mongoose = require("mongoose");

const AddressSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true }, // real user id
  chain: { type: String, required: true },               // "ethereum","bsc","tron","btc","solana"
  index: { type: Number, required: true },
  address: { type: String, required: true },
  
  // DO NOT USE THIS ANYMORE
  privateKey: { type: String, select: false },

  path: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Address", AddressSchema);