# InterNull EVM Smart Contracts

Solidity smart contracts for the InterNull privacy protocol on EVM-compatible chains.

## Overview

InterNull uses ECDSA-based one-time signatures (OTS) to provide privacy-preserving deposits and withdrawals across multiple chains and tokens. Users deposit ETH or ERC20 tokens, receive OTS keys via a DKG node network, and withdraw to any address without a link between deposit and withdrawal.

## Core Contracts

- **`MultiTokenTreasury.sol`** - Main treasury contract supporting native ETH and ERC20 tokens with configurable denominations, Merkle-based key verification, nullifier double-spend prevention, and gas-free relayer withdrawals
- **`MerkleVerifier.sol`** - Library for verifying Merkle proofs against batched key roots
- **`TokenHandler.sol`** - Library for handling native ETH and ERC20 token transfers
- **`GetterHelpers.sol`** - Library providing view functions for contract state queries
- **`MockERC20.sol`** - Test ERC20 token (used for USDC mock on testnets)

## Deployed Networks

| Network | Chain ID | Treasury Address |
|---------|----------|-----------------|
| Ethereum Sepolia | 11155111 | `0x2438Df77063C9df174Dc68C30B3177b4541312c4` |
| Base Sepolia | 84532 | `0x508732e0AAD03C472C2f1b43A94953CcA4F510E1` |
| BNB Testnet | 97 | `0x4cd2C502a4C0615dbdDd207fAE0E8085e5360D34` |
| Polygon Amoy | 80002 | `0x39Ff2ad0589Ceb82B941Ccb0E85d59A7806B471D` |
| Hyperliquid Testnet | 998 | `0x8F6f1713a8B1987A8a96cEAc1734c4b2f7CAd55c` |

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file:
```bash
DEPLOYER_PRIVATE_KEY=0x...
SEPOLIA_RPC_URL=https://...
ETHERSCAN_API_KEY=...
```

3. Compile contracts:
```bash
npx hardhat compile
```

4. Run tests:
```bash
npx hardhat test
```

## Deployment

### Local Development
```bash
# Start local node
npx hardhat node

# Deploy contracts (in another terminal)
npx hardhat run scripts/deploy-multitoken.js --network localhost
```

### Testnet Deployment
```bash
# Sepolia
npx hardhat run scripts/deploy-sepolia.js --network sepolia

# Base Sepolia
npx hardhat run scripts/deploy-base-sepolia.js --network baseSepolia

# BNB Testnet
npx hardhat run scripts/deploy-bnb.js --network bnbTestnet

# Polygon Amoy
npx hardhat run scripts/deploy-amoy.js --network amoy

# Hyperliquid Testnet
npx hardhat run scripts/deploy-hyperliquid.js --network hyperliquidTestnet
```

## Scripts

- `deploy-*.js` - Chain-specific deployment scripts
- `deploy-multitoken.js` - Generic multi-token deployment
- `add-merkle-root.js` - Add Merkle roots for OTS key batches
- `add-denomination-base-sepolia.js` - Add token denominations

## Configuration

Configure networks in `hardhat.config.js`. Private keys and RPC URLs are loaded from environment variables via `.env`.

## Security

- Reentrancy protection via OpenZeppelin's `ReentrancyGuard`
- Pausable emergency controls via `Pausable`
- Nullifier-based double-spend prevention
- ECDSA signature verification for withdrawal authorization
- Merkle proof verification for key batch membership
- Never commit private keys or `.env` files to the repository
