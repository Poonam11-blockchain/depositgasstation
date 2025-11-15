// // models/Wallet.js
// const mongoose = require("mongoose");

// const NetworkSchema = new mongoose.Schema({
//   address: { type: String, required: true },
//   // Encrypted private key (string) — optional
//   privateKey: { type: String },
//   path: { type: String },
// });

// const SolSchema = new mongoose.Schema({
//   address: { type: String, required: true },
//   privateKey: { type: String },
//   path: { type: String },
//   index: { type: Number },
// });

// const WalletSchema = new mongoose.Schema({
//   userId: { type: String, required: true, index: true },
//   evm: NetworkSchema,
//   bsc: NetworkSchema,
//   tron: NetworkSchema,
//   btc: NetworkSchema,
//   solana: SolSchema,
//   createdAt: { type: Date, default: Date.now },
// });

// module.exports = mongoose.model("Wallet", WalletSchema);

// models/Address.js
const mongoose = require("mongoose");

const AddressSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true }, // replace with real user id if available
  chain: { type: String, required: true },               // "ethereum","bsc","tron","btc","solana"
  index: { type: Number, required: true },
  address: { type: String, required: true },
  privateKey: { type: String },
  path: { type: String },
  meta: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Address", AddressSchema);
