use anyhow::{Context, Result};
use chrono::Utc;
use ethers::core::types::transaction::eip712::{EIP712Domain, Eip712};
use ethers::signers::{LocalWallet, Signer};
use ethers::types::{Address, Signature, H256, U256};
use serde::{Deserialize, Serialize};
use tracing::info;

const CHAIN_ID: u64 = 137; // Polygon
const CTF_EXCHANGE: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClobOrder {
    pub token_id: String,
    pub side: String,
    pub price: String,
    pub size: String,
    pub fee_rate_bps: String,
    pub nonce: String,
    pub expiration: String,
    pub taker: String,
    pub maker: String,
    pub signature_type: u8,
}

/// EIP-712 typed struct for Polymarket CLOB order signing
#[derive(Debug, Clone)]
struct OrderData {
    salt: U256,
    maker: Address,
    signer: Address,
    taker: Address,
    token_id: U256,
    maker_amount: U256,
    taker_amount: U256,
    expiration: U256,
    nonce: U256,
    fee_rate_bps: U256,
    side: u8,
    signature_type: u8,
}

pub struct OrderSigner {
    wallet: LocalWallet,
    address: Address,
}

impl OrderSigner {
    pub fn new(private_key: &str) -> Result<Self> {
        let key = private_key.strip_prefix("0x").unwrap_or(private_key);
        let wallet: LocalWallet = key
            .parse::<LocalWallet>()
            .context("Failed to parse private key")?
            .with_chain_id(CHAIN_ID);
        let address = wallet.address();

        info!("Order signer initialized for address: {address:?}");

        Ok(Self { wallet, address })
    }

    pub fn address(&self) -> Address {
        self.address
    }

    /// Build and sign a CLOB limit order for Polymarket.
    pub async fn sign_order(
        &self,
        token_id: &str,
        side: &str,
        price: f64,
        size: f64,
        neg_risk: bool,
    ) -> Result<SignedOrder> {
        let is_buy = side == "BUY";
        let size_raw = (size * 1_000_000.0).round() as u64;

        let (maker_amount, taker_amount) = if is_buy {
            let cost = (size * price * 1_000_000.0).round() as u64;
            (cost, size_raw)
        } else {
            (size_raw, (size * price * 1_000_000.0).round() as u64)
        };

        let nonce: u64 = rand::random();
        let salt: u64 = rand::random();
        let expiration = (Utc::now().timestamp() + 300) as u64; // 5 min

        let exchange = if neg_risk {
            NEG_RISK_CTF_EXCHANGE
        } else {
            CTF_EXCHANGE
        };

        let domain = EIP712Domain {
            name: Some("Polymarket CTF Exchange".to_string()),
            version: Some("1".to_string()),
            chain_id: Some(CHAIN_ID.into()),
            verifying_contract: Some(exchange.parse()?),
            salt: None,
        };

        let order_hash = self.compute_order_hash(
            salt,
            token_id,
            maker_amount,
            taker_amount,
            expiration,
            nonce,
            if is_buy { 0u8 } else { 1u8 },
            &domain,
        )?;

        let signature = self.wallet.sign_hash(H256::from(order_hash))?;

        Ok(SignedOrder {
            order: ClobOrder {
                token_id: token_id.to_string(),
                side: side.to_string(),
                price: format!("{:.2}", price),
                size: format!("{:.6}", size),
                fee_rate_bps: "0".to_string(),
                nonce: nonce.to_string(),
                expiration: expiration.to_string(),
                taker: format!("{:?}", Address::zero()),
                maker: format!("{:?}", self.address),
                signature_type: 2,
            },
            signature: format!("0x{}", hex::encode(signature_to_bytes(&signature))),
        })
    }

    fn compute_order_hash(
        &self,
        salt: u64,
        token_id: &str,
        maker_amount: u64,
        taker_amount: u64,
        expiration: u64,
        nonce: u64,
        side: u8,
        domain: &EIP712Domain,
    ) -> Result<[u8; 32]> {
        use ethers::utils::keccak256;

        let order_typehash = keccak256(
            b"Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)"
        );

        let token_id_u256: U256 = if token_id.starts_with("0x") {
            U256::from_str_radix(&token_id[2..], 16).unwrap_or_default()
        } else {
            U256::from_dec_str(token_id).unwrap_or_default()
        };

        let struct_hash = keccak256(ethers::abi::encode(&[
            ethers::abi::Token::FixedBytes(order_typehash.to_vec()),
            ethers::abi::Token::Uint(U256::from(salt)),
            ethers::abi::Token::Address(self.address),
            ethers::abi::Token::Address(self.address),
            ethers::abi::Token::Address(Address::zero()),
            ethers::abi::Token::Uint(token_id_u256),
            ethers::abi::Token::Uint(U256::from(maker_amount)),
            ethers::abi::Token::Uint(U256::from(taker_amount)),
            ethers::abi::Token::Uint(U256::from(expiration)),
            ethers::abi::Token::Uint(U256::from(nonce)),
            ethers::abi::Token::Uint(U256::from(0u64)),
            ethers::abi::Token::Uint(U256::from(side)),
            ethers::abi::Token::Uint(U256::from(2u64)),
        ]));

        let domain_separator = keccak256(ethers::abi::encode(&[
            ethers::abi::Token::FixedBytes(
                keccak256(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
                    .to_vec(),
            ),
            ethers::abi::Token::FixedBytes(keccak256(b"Polymarket CTF Exchange").to_vec()),
            ethers::abi::Token::FixedBytes(keccak256(b"1").to_vec()),
            ethers::abi::Token::Uint(U256::from(CHAIN_ID)),
            ethers::abi::Token::Address(domain.verifying_contract.unwrap()),
        ]));

        let digest_input = [
            &[0x19, 0x01],
            domain_separator.as_slice(),
            struct_hash.as_slice(),
        ]
        .concat();

        Ok(keccak256(digest_input))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SignedOrder {
    pub order: ClobOrder,
    pub signature: String,
}

fn signature_to_bytes(sig: &Signature) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(65);
    let mut r_bytes = [0u8; 32];
    sig.r.to_big_endian(&mut r_bytes);
    bytes.extend_from_slice(&r_bytes);
    let mut s_bytes = [0u8; 32];
    sig.s.to_big_endian(&mut s_bytes);
    bytes.extend_from_slice(&s_bytes);
    bytes.push(sig.v as u8);
    bytes
}
