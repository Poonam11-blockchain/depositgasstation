
//generateMultichainwallets.js
require("dotenv").config();
const { ethers } = require("ethers");
const bip39 = require("bip39");
const bip32 = require("bip32");
const bitcoin = require("bitcoinjs-lib");
const TronWeb = require("tronweb");
const { Keypair } = require("@solana/web3.js");
const { derivePath } = require("ed25519-hd-key");
const _bs58 = require("bs58");
const bs58 = _bs58 && _bs58.default ? _bs58.default : _bs58;

const BTC_NETWORK = bitcoin.networks.testnet;

// === BASE DERIVATION PATHS (index appended later) ===
const EVM_BASE = `m/44'/60'/0'/0/`;      // ETH / BSC / POLYGON -> append index
const TRON_BASE = `m/44'/195'/0'/0/`;    // TRON      -> append index
const BTC_BASE = `m/84'/1'/0'/0/`;       // BTC TEST  -> append index
const SOL_TEMPLATE = `m/44'/501'/{i}'/0'`;

const tronWeb = new TronWeb({ fullHost: "https://api.shasta.trongrid.io" });

function deriveSolKeypairFromMnemonic(mnemonic, index = 0) {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const path = SOL_TEMPLATE.replace("{i}", index.toString());
  const derived = derivePath(path, seed.toString("hex"));
  const seed32 = derived.key.slice(0, 32);
  const kp = Keypair.fromSeed(seed32);
  return { kp, path };
}

/**
 * Generate wallet for ALL CHAINS using index
 */
function generateWalletFromMnemonic(mnemonic = null, opts = {}) {
  mnemonic = mnemonic || process.env.MNEMONIC;
  if (!mnemonic) throw new Error("MNEMONIC missing");
  if (!bip39.validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic");

  const index = Number(opts.index || 0);   // <-- index here

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const evmRoot = ethers.utils.HDNode.fromMnemonic(mnemonic);
  const bip32Root = bip32.fromSeed(seed, BTC_NETWORK);

  // ---- EVM (ETH/BSC) ----
  const evmPath = `${EVM_BASE}${index}`;
  const evmNode = evmRoot.derivePath(evmPath);
  const evmAddress = evmNode.address;
  const evmPriv = evmNode.privateKey;

  // ---- TRON ----
  const tronPath = `${TRON_BASE}${index}`;
  const tronNode = evmRoot.derivePath(tronPath);
  const tronPrivRaw = tronNode.privateKey.replace(/^0x/, "");
  const tronAddress = tronWeb.address.fromPrivateKey(tronPrivRaw);

  // ---- BTC ----
  const btcPath = `${BTC_BASE}${index}`;
  const btcNode = bip32Root.derivePath(btcPath);
  const { address: btcAddress } = bitcoin.payments.p2wpkh({
    pubkey: btcNode.publicKey,
    network: BTC_NETWORK,
  });
  const btcPriv = btcNode.toWIF();

  // ---- SOLANA ----
  const { kp: solKp, path: solPath } = deriveSolKeypairFromMnemonic(mnemonic, index);
  const solAddress = solKp.publicKey.toBase58();
  const solSecretBase58 = bs58.encode(Buffer.from(solKp.secretKey));
  const solSecretArray = Array.from(solKp.secretKey);

  return {
    userId: Date.now().toString(),
    index,

    ethereum: {
      address: evmAddress,
      privateKey: evmPriv,
      path: evmPath,
    },

    bsc: {
      address: evmAddress,
      privateKey: evmPriv,
      path: evmPath,
    },
    
    polygon: {
      address: evmAddress,
      privateKey: evmPriv,
      path: evmPath,
    },

    tron: {
      address: tronAddress,
      privateKey: `0x${tronPrivRaw}`,
      path: tronPath,
    },

    btc: {
      address: btcAddress,
      privateKey: btcPriv,
      path: btcPath,
    },

    solana: {
      address: solAddress,
      privateKey: solSecretBase58,
      privateKeyArray: solSecretArray,
      path: solPath,
      index,
    },

    createdAt: new Date().toISOString(),
  };
}

module.exports = { generateWalletFromMnemonic };
