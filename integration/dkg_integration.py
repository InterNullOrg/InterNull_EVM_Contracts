#!/usr/bin/env python3
"""
DKG-Treasury Integration Script
Connects the smart contract system with the DKG nodes for end-to-end testing
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from web3 import Web3
from eth_account import Account
import requests

from core.treasury.blockchain import BlockchainVerifier
from core.treasury.metadata import TreasuryMetadataStore, TokenConfig, KeyMetadata, KeyStatus
from storage.key_store import FileStorageBackend

class DKGTreasuryIntegration:
    """Integration between DKG system and treasury smart contracts"""
    
    def __init__(self, config: Dict):
        self.config = config
        self.w3 = Web3(Web3.HTTPProvider(config['rpc_url']))
        self.account = Account.from_key(config['private_key'])
        self.contract_address = config['contract_address']
        
        # Load contract ABI
        with open(config['abi_path'], 'r') as f:
            self.contract_abi = json.load(f)
        
        self.factory_contract = self.w3.eth.contract(
            address=self.contract_address,
            abi=self.contract_abi
        )
        
        # Initialize storage and metadata
        storage_backend = FileStorageBackend(config['storage_path'])
        self.metadata_store = TreasuryMetadataStore(storage_backend)
        
        # Initialize blockchain verifier
        blockchain_config = {
            'rpc_url': config['rpc_url'],
            'chain_id': config['chain_id'],
            'contract_address': config['contract_address'],
            'contract_abi': config['abi_path']
        }
        self.blockchain_verifier = BlockchainVerifier(blockchain_config)
        
        print(f"✅ Connected to blockchain (Chain ID: {self.w3.eth.chain_id})")
        print(f"✅ Account: {self.account.address}")
        print(f"✅ Factory contract: {self.contract_address}")
    
    async def setup_treasury_system(self):
        """Set up the complete treasury system"""
        print("\n🏗️  Setting up treasury system...")
        
        # 1. Deploy treasury contracts if needed
        await self._ensure_treasuries_deployed()
        
        # 2. Sync token configurations
        await self._sync_token_configurations()
        
        # 3. Deploy initial merkle roots
        await self._deploy_initial_merkle_roots()
        
        print("✅ Treasury system setup complete")
    
    async def _ensure_treasuries_deployed(self):
        """Ensure required treasury contracts are deployed"""
        print("📦 Checking deployed treasuries...")
        
        try:
            # Get supported tokens
            tokens_data = self.factory_contract.functions.getSupportedTokens().call()
            tokens, symbols, decimals, denominations = tokens_data
            
            print(f"Found {len(tokens)} deployed treasuries:")
            for i, (token, symbol) in enumerate(zip(tokens, symbols)):
                print(f"  - {symbol}: {token}")
            
            # Check if ETH treasury exists
            eth_treasury = self.factory_contract.functions.getTreasury(
                "0x0000000000000000000000000000000000000000"
            ).call()
            
            if eth_treasury == "0x0000000000000000000000000000000000000000":
                print("⚠️  ETH treasury not found, deploying...")
                await self._deploy_eth_treasury()
            else:
                print(f"✅ ETH treasury found: {eth_treasury}")
                
        except Exception as e:
            print(f"❌ Error checking treasuries: {e}")
            raise
    
    async def _deploy_eth_treasury(self):
        """Deploy ETH treasury with standard denominations"""
        denominations = [
            self.w3.to_wei(0.01, 'ether'),  # 0.01 ETH
            self.w3.to_wei(0.1, 'ether'),   # 0.1 ETH
            self.w3.to_wei(1.0, 'ether'),   # 1.0 ETH
        ]
        
        try:
            # Build transaction
            function = self.factory_contract.functions.deployETHTreasury(
                denominations,
                self.account.address
            )
            
            tx = function.build_transaction({
                'from': self.account.address,
                'nonce': self.w3.eth.get_transaction_count(self.account.address),
                'gas': 3000000,
                'gasPrice': self.w3.to_wei(20, 'gwei')
            })
            
            # Sign and send transaction
            signed_tx = self.account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed_tx.rawTransaction)
            
            print(f"📤 ETH treasury deployment tx: {tx_hash.hex()}")
            
            # Wait for confirmation
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status == 1:
                print("✅ ETH treasury deployed successfully")
            else:
                raise Exception("Transaction failed")
                
        except Exception as e:
            print(f"❌ Failed to deploy ETH treasury: {e}")
            raise
    
    async def _sync_token_configurations(self):
        """Sync token configurations from smart contracts"""
        print("🔄 Syncing token configurations...")
        
        try:
            # Get supported tokens from factory
            tokens_data = self.factory_contract.functions.getSupportedTokens().call()
            tokens, symbols, decimals, denominations = tokens_data
            
            for i, (token_addr, symbol, decimal, denoms) in enumerate(zip(tokens, symbols, decimals, denominations)):
                # Convert denominations to float for storage
                denom_values = [float(self.w3.from_wei(d, 'ether')) if token_addr == "0x0000000000000000000000000000000000000000"
                               else float(d) / (10 ** decimal) for d in denoms]
                
                # Create token config
                config = TokenConfig(
                    chain_id=self.w3.eth.chain_id,
                    contract_address=self.contract_address,
                    token_address=token_addr,
                    token_symbol=symbol,
                    token_decimals=decimal,
                    denominations=denom_values
                )
                
                # Save to metadata store
                await self.metadata_store.add_token_config(config)
                print(f"  ✅ Synced {symbol}: {len(denom_values)} denominations")
            
        except Exception as e:
            print(f"❌ Error syncing token configurations: {e}")
            raise
    
    async def _deploy_initial_merkle_roots(self):
        """Deploy initial merkle roots for testing"""
        print("🌳 Deploying initial merkle roots...")
        
        try:
            # Get ETH treasury
            eth_treasury_addr = self.factory_contract.functions.getTreasury(
                "0x0000000000000000000000000000000000000000"
            ).call()
            
            if eth_treasury_addr == "0x0000000000000000000000000000000000000000":
                print("❌ ETH treasury not found")
                return
            
            # Load ETH treasury contract
            with open(self.config['treasury_abi_path'], 'r') as f:
                treasury_abi = json.load(f)
            
            eth_treasury = self.w3.eth.contract(
                address=eth_treasury_addr,
                abi=treasury_abi
            )
            
            # Deploy test merkle root
            test_merkle_root = "0x" + "1" * 64  # Test root
            denomination = self.w3.to_wei(0.1, 'ether')  # 0.1 ETH
            total_keys = 100
            expiry_days = 30
            
            # Check if root already exists
            try:
                root_info = eth_treasury.functions.getRootInfo(test_merkle_root).call()
                if root_info[6]:  # exists field
                    print(f"  ✅ Test merkle root already exists")
                    return
            except:
                pass
            
            # Deploy merkle root
            function = eth_treasury.functions.deployMerkleRoot(
                test_merkle_root,
                denomination,
                total_keys,
                expiry_days
            )
            
            tx = function.build_transaction({
                'from': self.account.address,
                'nonce': self.w3.eth.get_transaction_count(self.account.address),
                'gas': 200000,
                'gasPrice': self.w3.to_wei(20, 'gwei')
            })
            
            signed_tx = self.account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed_tx.rawTransaction)
            
            print(f"📤 Merkle root deployment tx: {tx_hash.hex()}")
            
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status == 1:
                print("✅ Test merkle root deployed successfully")
            else:
                raise Exception("Transaction failed")
                
        except Exception as e:
            print(f"❌ Error deploying merkle roots: {e}")
            # Don't raise here, this is not critical for testing
    
    async def test_deposit_flow(self):
        """Test the complete deposit and verification flow"""
        print("\n💰 Testing deposit flow...")
        
        try:
            # Get ETH treasury address
            eth_treasury_addr = self.factory_contract.functions.getTreasury(
                "0x0000000000000000000000000000000000000000"
            ).call()
            
            if eth_treasury_addr == "0x0000000000000000000000000000000000000000":
                print("❌ ETH treasury not found")
                return False
            
            # Load treasury contract
            with open(self.config['treasury_abi_path'], 'r') as f:
                treasury_abi = json.load(f)
            
            eth_treasury = self.w3.eth.contract(
                address=eth_treasury_addr,
                abi=treasury_abi
            )
            
            # Test deposit
            test_merkle_root = "0x" + "1" * 64
            key_count = 1
            deposit_amount = self.w3.to_wei(0.1, 'ether')
            
            function = eth_treasury.functions.deposit(test_merkle_root, key_count)
            
            tx = function.build_transaction({
                'from': self.account.address,
                'value': deposit_amount,
                'nonce': self.w3.eth.get_transaction_count(self.account.address),
                'gas': 150000,
                'gasPrice': self.w3.to_wei(20, 'gwei')
            })
            
            signed_tx = self.account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed_tx.rawTransaction)
            
            print(f"📤 Test deposit tx: {tx_hash.hex()}")
            
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status == 1:
                print("✅ Test deposit successful")
                
                # Verify deposit using blockchain verifier
                verification = await self.blockchain_verifier.verify_deposit(
                    self.account.address,
                    "0x0000000000000000000000000000000000000000",  # ETH
                    0.1,  # 0.1 ETH
                    tx_hash.hex()
                )
                
                if verification and verification.get('verified'):
                    print("✅ Deposit verification successful")
                    return True
                else:
                    print("❌ Deposit verification failed")
                    return False
            else:
                print("❌ Test deposit failed")
                return False
                
        except Exception as e:
            print(f"❌ Error testing deposit flow: {e}")
            return False
    
    async def test_dkg_integration(self):
        """Test integration with DKG nodes"""
        print("\n🔗 Testing DKG integration...")
        
        try:
            # Try to connect to DKG nodes
            dkg_nodes = [
                "http://localhost:8001",
                "http://localhost:8002",
                "http://localhost:8003"
            ]
            
            connected_nodes = []
            for node_url in dkg_nodes:
                try:
                    response = requests.get(f"{node_url}/health", timeout=5)
                    if response.status_code == 200:
                        connected_nodes.append(node_url)
                        print(f"  ✅ Connected to DKG node: {node_url}")
                    else:
                        print(f"  ❌ DKG node unhealthy: {node_url}")
                except Exception as e:
                    print(f"  ❌ Cannot connect to DKG node {node_url}: {e}")
            
            if len(connected_nodes) == 0:
                print("❌ No DKG nodes available for testing")
                return False
            
            # Test key request
            test_request = {
                "wallet_address": self.account.address,
                "chain_id": self.w3.eth.chain_id,
                "token_address": "0x0000000000000000000000000000000000000000",
                "denomination": 0.1
            }
            
            node_url = connected_nodes[0]
            response = requests.post(
                f"{node_url}/api/v1/continuous/keys/request",
                json=test_request,
                timeout=10
            )
            
            if response.status_code == 200:
                result = response.json()
                if result.get('success'):
                    print("✅ DKG key request successful")
                    print(f"  Key ID: {result['reservation']['key_id']}")
                    return True
                else:
                    print(f"❌ DKG key request failed: {result}")
                    return False
            else:
                print(f"❌ DKG key request failed: {response.status_code}")
                return False
                
        except Exception as e:
            print(f"❌ Error testing DKG integration: {e}")
            return False
    
    async def test_frontend_integration(self):
        """Test integration with frontend"""
        print("\n🌐 Testing frontend integration...")
        
        try:
            # Try to connect to frontend
            frontend_url = "http://localhost:80"
            
            try:
                response = requests.get(frontend_url, timeout=5)
                if response.status_code == 200:
                    print(f"✅ Frontend accessible at: {frontend_url}")
                else:
                    print(f"❌ Frontend responded with: {response.status_code}")
                    return False
            except Exception as e:
                print(f"❌ Cannot connect to frontend: {e}")
                return False
            
            # Test API endpoint
            try:
                api_response = requests.get(f"{frontend_url}/api/config", timeout=5)
                if api_response.status_code == 200:
                    print("✅ Frontend API accessible")
                    return True
                else:
                    print(f"❌ Frontend API error: {api_response.status_code}")
                    return False
            except Exception as e:
                print(f"⚠️  Frontend API not available (this is OK): {e}")
                return True  # Frontend might not have API endpoint
                
        except Exception as e:
            print(f"❌ Error testing frontend integration: {e}")
            return False

async def main():
    """Main integration test function"""
    print("🚀 Starting DKG-Treasury Integration Test")
    
    # Load configuration
    config = {
        'rpc_url': os.getenv('RPC_URL', 'http://localhost:8545'),
        'chain_id': int(os.getenv('CHAIN_ID', '31337')),
        'contract_address': os.getenv('CONTRACT_ADDRESS'),
        'private_key': os.getenv('PRIVATE_KEY'),
        'abi_path': './treasury_factory_abi.json',
        'treasury_abi_path': './eth_treasury_abi.json',
        'storage_path': './integration_test_data'
    }
    
    # Validate configuration
    if not config['contract_address']:
        print("❌ CONTRACT_ADDRESS environment variable required")
        return False
    
    if not config['private_key']:
        print("❌ PRIVATE_KEY environment variable required")
        return False
    
    # Create ABI files if they don't exist (simplified versions for testing)
    if not os.path.exists(config['abi_path']):
        factory_abi = [
            {
                "constant": True,
                "inputs": [],
                "name": "getSupportedTokens",
                "outputs": [
                    {"name": "tokens", "type": "address[]"},
                    {"name": "symbols", "type": "string[]"},
                    {"name": "decimals", "type": "uint8[]"},
                    {"name": "denominations", "type": "uint256[][]"}
                ],
                "type": "function"
            },
            {
                "constant": True,
                "inputs": [{"name": "tokenAddress", "type": "address"}],
                "name": "getTreasury",
                "outputs": [{"name": "", "type": "address"}],
                "type": "function"
            }
        ]
        with open(config['abi_path'], 'w') as f:
            json.dump(factory_abi, f)
    
    try:
        # Initialize integration tester
        integration = DKGTreasuryIntegration(config)
        
        # Run tests
        await integration.setup_treasury_system()
        
        deposit_success = await integration.test_deposit_flow()
        dkg_success = await integration.test_dkg_integration()
        frontend_success = await integration.test_frontend_integration()
        
        # Summary
        print("\n📊 Integration Test Results:")
        print(f"  Deposit Flow: {'✅ PASS' if deposit_success else '❌ FAIL'}")
        print(f"  DKG Integration: {'✅ PASS' if dkg_success else '❌ FAIL'}")
        print(f"  Frontend Integration: {'✅ PASS' if frontend_success else '❌ FAIL'}")
        
        overall_success = deposit_success and dkg_success and frontend_success
        print(f"\n🎯 Overall Result: {'✅ SUCCESS' if overall_success else '❌ PARTIAL/FAILURE'}")
        
        if overall_success:
            print("\n🎉 All systems integrated successfully!")
            print("You can now:")
            print("  1. Access the frontend at http://localhost:80")
            print("  2. Request keys through the DKG nodes")
            print("  3. Make deposits to the treasury contracts")
            print("  4. Test the complete anonymization flow")
        
        return overall_success
        
    except Exception as e:
        print(f"❌ Integration test failed: {e}")
        return False

if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)