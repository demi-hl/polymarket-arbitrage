/**
 * Polymarket CLOB Order Signer
 * EIP-712 typed data signing for CTF Exchange orders + L2 HMAC auth headers.
 *
 * References:
 *   - Rust signer: rust-engine/src/signer.rs
 *   - Official TS client: @polymarket/clob-client/src/order-utils
 *   - EIP-712 spec for "Polymarket CTF Exchange" v1 on Polygon (chainId 137)
 */
const { ethers } = require('ethers');
const crypto = require('crypto');

// ── Constants ──────────────────────────────────────────────────────────────────

const CHAIN_ID = 137; // Polygon mainnet

const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// 6-decimal fixed-point (USDC scale)
const SCALE = 1_000_000;

// Polymarket CTF Exchange EIP-712 domain
const EIP712_DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: CHAIN_ID,
};

// EIP-712 Order type definition (must match contract)
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

// Tick size -> decimal precision mapping (mirrors official client)
const TICK_CONFIGS = {
  '0.1':    { priceDecimals: 1, sizeDecimals: 2, amountDecimals: 3 },
  '0.01':   { priceDecimals: 2, sizeDecimals: 2, amountDecimals: 4 },
  '0.001':  { priceDecimals: 3, sizeDecimals: 2, amountDecimals: 5 },
  '0.0001': { priceDecimals: 4, sizeDecimals: 2, amountDecimals: 6 },
};

// ── Utility helpers ────────────────────────────────────────────────────────────

function randomSalt() {
  // 128-bit random nonce as bigint
  return BigInt('0x' + crypto.randomBytes(16).toString('hex'));
}

function randomNonce() {
  return BigInt('0x' + crypto.randomBytes(8).toString('hex'));
}

function toRawAmount(value, decimals = 6) {
  // Round to `decimals` places, then scale to integer
  const rounded = Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
  return BigInt(Math.round(rounded * SCALE));
}

// ── HMAC L2 Auth ───────────────────────────────────────────────────────────────

/**
 * Build HMAC-SHA256 signature for Polymarket L2 authenticated endpoints.
 * Message format: timestamp + method + requestPath [+ body]
 *
 * @param {string} secret - base64-encoded API secret
 * @param {string} timestamp - unix timestamp string
 * @param {string} method - HTTP method (GET, POST, DELETE)
 * @param {string} requestPath - URL path (e.g. /order)
 * @param {string} [body] - JSON request body (omit for GET)
 * @returns {string} base64url-encoded HMAC signature
 */
function buildHmacSignature(secret, timestamp, method, requestPath, body) {
  let message = timestamp + method + requestPath;
  if (body) {
    message += body;
  }

  // Decode base64url secret
  const secretBuf = Buffer.from(secret, 'base64');
  const hmac = crypto.createHmac('sha256', secretBuf);
  hmac.update(message);
  const sig = hmac.digest('base64');

  // Convert to base64url
  return sig.replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Generate the full set of L2 auth headers for a CLOB request.
 *
 * @param {object} creds - { key, secret, passphrase }
 * @param {string} address - Polygon wallet address
 * @param {string} method - HTTP method
 * @param {string} path - URL path
 * @param {string} [body] - JSON body string
 * @returns {object} headers object
 */
function buildL2Headers(creds, address, method, path, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = buildHmacSignature(creds.secret, timestamp, method, path, body);

  return {
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_API_KEY': creds.key,
    'POLY_PASSPHRASE': creds.passphrase,
  };
}

// ── EIP-712 Order Signer ───────────────────────────────────────────────────────

class ClobSigner {
  /**
   * @param {object} opts
   * @param {string} opts.privateKey - hex private key (with or without 0x)
   * @param {object} opts.apiCreds - { key, secret, passphrase }
   * @param {string} [opts.funderAddress] - proxy/funder address (defaults to signer address)
   */
  constructor(opts) {
    const key = opts.privateKey.startsWith('0x') ? opts.privateKey : `0x${opts.privateKey}`;
    this.wallet = new ethers.Wallet(key);
    this.address = this.wallet.address;
    this.funderAddress = opts.funderAddress || this.address;
    this.apiCreds = opts.apiCreds;
  }

  /**
   * Build and sign a CLOB limit order.
   *
   * @param {object} params
   * @param {string} params.tokenId - CTF ERC1155 token ID
   * @param {'BUY'|'SELL'} params.side
   * @param {number} params.price - limit price (0..1)
   * @param {number} params.size - size in shares (or USDC notional for buys)
   * @param {boolean} [params.negRisk=false] - use NegRisk CTF Exchange
   * @param {number} [params.feeRateBps=0] - fee rate in bps
   * @param {string} [params.tickSize='0.01'] - tick size for rounding
   * @param {number} [params.expirationSec=300] - order TTL in seconds
   * @returns {Promise<object>} signed order payload ready for POST /order
   */
  async signOrder(params) {
    const {
      tokenId,
      side,
      price,
      size,
      negRisk = false,
      feeRateBps = 0,
      tickSize = '0.01',
      expirationSec = 300,
    } = params;

    const config = TICK_CONFIGS[tickSize] || TICK_CONFIGS['0.01'];
    const isBuy = side === 'BUY';
    const sideInt = isBuy ? 0 : 1;

    // Compute raw amounts (6-decimal fixed-point)
    const roundedPrice = parseFloat(price.toFixed(config.priceDecimals));
    const roundedSize = parseFloat(size.toFixed(config.sizeDecimals));

    let makerAmount, takerAmount;
    if (isBuy) {
      // Buyer provides USDC (price * size), receives shares (size)
      makerAmount = toRawAmount(roundedPrice * roundedSize, config.amountDecimals);
      takerAmount = toRawAmount(roundedSize, config.amountDecimals);
    } else {
      // Seller provides shares (size), receives USDC (price * size)
      makerAmount = toRawAmount(roundedSize, config.amountDecimals);
      takerAmount = toRawAmount(roundedPrice * roundedSize, config.amountDecimals);
    }

    const salt = randomSalt();
    const nonce = randomNonce();
    const expiration = BigInt(Math.floor(Date.now() / 1000) + expirationSec);
    const exchange = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

    // EIP-712 typed data message
    const orderMessage = {
      salt: salt,
      maker: this.funderAddress,
      signer: this.address,
      taker: ZERO_ADDRESS,
      tokenId: BigInt(tokenId),
      makerAmount: makerAmount,
      takerAmount: takerAmount,
      expiration: expiration,
      nonce: nonce,
      feeRateBps: BigInt(feeRateBps),
      side: sideInt,
      signatureType: 0, // EOA
    };

    const domain = { ...EIP712_DOMAIN, verifyingContract: exchange };

    // ethers v6 signTypedData
    const signature = await this.wallet.signTypedData(domain, ORDER_TYPES, orderMessage);

    // Build the order payload matching POST /order body shape
    return {
      order: {
        salt: salt.toString(),
        maker: this.funderAddress,
        signer: this.address,
        taker: ZERO_ADDRESS,
        tokenId: tokenId.toString(),
        makerAmount: makerAmount.toString(),
        takerAmount: takerAmount.toString(),
        expiration: expiration.toString(),
        nonce: nonce.toString(),
        feeRateBps: feeRateBps.toString(),
        side: side,
        signature: signature,
        signatureType: 0,
      },
      owner: this.apiCreds.key,
      orderType: 'GTC',
    };
  }

  /**
   * Generate L2 auth headers for an authenticated CLOB request.
   *
   * @param {string} method - HTTP method
   * @param {string} path - request path (e.g. /order)
   * @param {string} [body] - JSON body string
   * @returns {object} headers
   */
  getAuthHeaders(method, path, body) {
    return buildL2Headers(this.apiCreds, this.address, method, path, body);
  }
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  ClobSigner,
  buildL2Headers,
  buildHmacSignature,
  CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE,
  CHAIN_ID,
  ZERO_ADDRESS,
};
