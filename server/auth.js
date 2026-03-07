/**
 * Auth Module — Wallet-based authentication for Locals Only
 *
 * Flow: Connect wallet → sign nonce → verify signature + NFT → JWT issued
 * No passwords, no database — file-based storage, crypto-native.
 *
 * JWT: Self-contained HMAC-SHA256 (no external dependencies)
 * NFT: Verified on HyperEVM chain 999 (Locals Only contract)
 * Credentials: AES-256-GCM encrypted per-user
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

// ── Config ──────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours
const NONCE_EXPIRY_MS = 5 * 60 * 1000;   // 5 minutes

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
const NFT_CONTRACT = '0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75';
const ERC721_BALANCEOF_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');

// ── Nonce Store (in-memory, ephemeral) ──────────────────
const nonces = new Map(); // address → { nonce, expires }

function generateNonce(address) {
  const addr = address.toLowerCase();
  const nonce = crypto.randomBytes(16).toString('hex');
  const expires = Date.now() + NONCE_EXPIRY_MS;
  nonces.set(addr, { nonce, expires });

  // Clean expired nonces every 100 calls
  if (nonces.size > 100) {
    const now = Date.now();
    for (const [key, val] of nonces) {
      if (val.expires < now) nonces.delete(key);
    }
  }

  const message = `Sign this message to authenticate with Locals Only Arbitrage Engine.\n\nNonce: ${nonce}\nAddress: ${address}\nTimestamp: ${new Date().toISOString()}`;
  return { nonce, message };
}

function consumeNonce(address) {
  const addr = address.toLowerCase();
  const entry = nonces.get(addr);
  if (!entry) return null;
  nonces.delete(addr);
  if (Date.now() > entry.expires) return null;
  return entry.nonce;
}

// ── Signature Verification ──────────────────────────────
function verifySignature(message, signature, expectedAddress) {
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

// ── NFT Verification (HyperEVM) ─────────────────────────
let _provider = null;
let _contract = null;

function getContract() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(HYPEREVM_RPC);
    _contract = new ethers.Contract(NFT_CONTRACT, ERC721_BALANCEOF_ABI, _provider);
  }
  return _contract;
}

async function checkNFTBalance(address) {
  try {
    const contract = getContract();
    const balance = await contract.balanceOf(address);
    return Number(balance);
  } catch (err) {
    console.error('NFT check failed:', err.message);
    return 0;
  }
}

// ── JWT (HMAC-SHA256, no dependencies) ───────────────────
function createJWT(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
  };

  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(fullPayload));
  const signature = hmacSign(`${encHeader}.${encPayload}`);
  return `${encHeader}.${encPayload}.${signature}`;
}

function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encHeader, encPayload, signature] = parts;
    const expectedSig = hmacSign(`${encHeader}.${encPayload}`);
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;

    const payload = JSON.parse(Buffer.from(encPayload, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

function base64url(str) {
  return Buffer.from(str).toString('base64url');
}

function hmacSign(data) {
  return crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
}

// ── Express Auth Middleware ──────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }

  const token = authHeader.slice(7);
  const payload = verifyJWT(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
  }

  req.user = {
    address: payload.address,
    nftBalance: payload.nftBalance,
  };
  next();
}

// Routes that skip auth
const PUBLIC_PATHS = [
  '/auth/nonce',
  '/auth/verify',
  '/auth/refresh',
  '/health',
];

function isPublicPath(path) {
  return PUBLIC_PATHS.some(p => path === p || path.startsWith(p));
}

// ── Per-User Data Directory ──────────────────────────────
function getUserDataDir(address) {
  let checksumAddr;
  try {
    checksumAddr = ethers.getAddress(address); // 0x-checksummed
  } catch {
    checksumAddr = address.toLowerCase(); // fallback to lowercase
  }
  const userDir = path.join(USERS_DIR, checksumAddr);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

function getUserFilePath(address, filename) {
  return path.join(getUserDataDir(address), filename);
}

function readUserFile(address, filename, defaultValue = null) {
  try {
    const filePath = getUserFilePath(address, filename);
    if (!fs.existsSync(filePath)) return defaultValue;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeUserFile(address, filename, data) {
  const filePath = getUserFilePath(address, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ── Credential Encryption (AES-256-GCM) ──────────────────
function deriveCredentialKey(address) {
  // Derive a unique encryption key per user from JWT_SECRET + address
  return crypto.createHash('sha256')
    .update(JWT_SECRET + ':' + address.toLowerCase())
    .digest();
}

function encryptCredentials(address, credentials) {
  const key = deriveCredentialKey(address);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(JSON.stringify(credentials), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  const data = {
    iv: iv.toString('hex'),
    encrypted,
    authTag,
    updatedAt: new Date().toISOString(),
  };

  writeUserFile(address, 'credentials.json', data);
  return true;
}

function decryptCredentials(address) {
  const data = readUserFile(address, 'credentials.json');
  if (!data || !data.encrypted) return null;

  try {
    const key = deriveCredentialKey(address);
    const iv = Buffer.from(data.iv, 'hex');
    const authTag = Buffer.from(data.authTag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (err) {
    console.error('Credential decryption failed for', address, ':', err.message);
    return null;
  }
}

function getCredentialStatus(address) {
  const creds = decryptCredentials(address);
  if (!creds) return { hasKey: false, hasApiKey: false, hasSecret: false, hasPassphrase: false };
  return {
    hasKey: !!creds.privateKey,
    hasApiKey: !!creds.apiKey,
    hasSecret: !!creds.apiSecret,
    hasPassphrase: !!creds.passphrase,
  };
}

function deleteCredentials(address) {
  const filePath = getUserFilePath(address, 'credentials.json');
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ── Initialize ───────────────────────────────────────────
function init() {
  if (!fs.existsSync(USERS_DIR)) {
    fs.mkdirSync(USERS_DIR, { recursive: true });
  }
  console.log('🔐 Auth module initialized');
  if (process.env.JWT_SECRET) {
    console.log('   JWT secret: from environment');
  } else {
    console.log('   JWT secret: auto-generated (set JWT_SECRET env var for persistence)');
  }
}

module.exports = {
  // Nonce flow
  generateNonce,
  consumeNonce,

  // Verification
  verifySignature,
  checkNFTBalance,

  // JWT
  createJWT,
  verifyJWT,

  // Middleware
  authMiddleware,
  isPublicPath,

  // Per-user data
  getUserDataDir,
  getUserFilePath,
  readUserFile,
  writeUserFile,

  // Credentials
  encryptCredentials,
  decryptCredentials,
  getCredentialStatus,
  deleteCredentials,

  // Init
  init,
};
