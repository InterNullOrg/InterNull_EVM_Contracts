const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("=====================================");
  console.log("Deploying to Hyperliquid Testnet");
  console.log("=====================================\n");

  // Get the deployer account
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log("Deployer address:", deployerAddress);

  // Check balance
  const balance = await deployer.getBalance();
  const balanceInEth = hre.ethers.utils.formatEther(balance);
  console.log("Deployer balance:", balanceInEth, "HYPE");

  if (balance.eq(0)) {
    console.error("\n❌ ERROR: Deployer has no HYPE!");
    console.log("\n📝 Get Hyperliquid testnet HYPE from:");
    console.log("   - https://app.hyperliquid-testnet.xyz/");
    console.log("   - Bridge from other testnet or request from faucet");
    console.log("\n   Your address:", deployerAddress);
    process.exit(1);
  }

  console.log("\n📦 Deploying contracts...\n");

  try {
    // 1. Deploy MerkleVerifier library
    console.log("1. Deploying MerkleVerifier library...");
    const MerkleVerifier = await hre.ethers.getContractFactory("MerkleVerifier");
    const merkleVerifier = await MerkleVerifier.deploy();
    await merkleVerifier.deployed();
    console.log("   ✅ MerkleVerifier deployed to:", merkleVerifier.address);

    // 2. Deploy MultiTokenTreasury (no library linking needed as it's included in bytecode)
    console.log("\n2. Deploying MultiTokenTreasury contract...");
    const MultiTokenTreasury = await hre.ethers.getContractFactory("MultiTokenTreasury");

    // Deploy with the deployer address as owner
    const treasury = await MultiTokenTreasury.deploy(deployerAddress);
    await treasury.deployed();
    console.log("   ✅ MultiTokenTreasury deployed to:", treasury.address);
    console.log("   ✅ Admin set to:", deployerAddress);

    // 3. Deploy MockERC20 for USDC testing (optional)
    console.log("\n3. Deploying MockERC20 (USDC) for testing...");
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    // Constructor: name, symbol, decimals, totalSupply
    const initialSupply = hre.ethers.utils.parseUnits("1000000", 6); // 1M USDC
    const mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6, initialSupply);
    await mockUSDC.deployed();
    console.log("   ✅ MockUSDC deployed to:", mockUSDC.address);
    console.log("   ✅ Initial supply: 1,000,000 USDC minted to deployer");

    // Save deployment info
    const deploymentInfo = {
      network: "hyperliquid_testnet",
      chainId: 998,
      deployer: deployerAddress,
      timestamp: new Date().toISOString(),
      contracts: {
        MerkleVerifier: {
          address: merkleVerifier.address,
          type: "library"
        },
        MultiTokenTreasury: {
          address: treasury.address,
          type: "main",
          admin: deployerAddress
        },
        MockUSDC: {
          address: mockUSDC.address,
          type: "test-token",
          decimals: 6
        }
      },
      blockExplorer: {
        MerkleVerifier: `https://testnet.purrsec.com/address/${merkleVerifier.address}`,
        MultiTokenTreasury: `https://testnet.purrsec.com/address/${treasury.address}`,
        MockUSDC: `https://testnet.purrsec.com/address/${mockUSDC.address}`
      }
    };

    // Save to file
    const deploymentsDir = path.join(__dirname, "../deployments");
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const filePath = path.join(deploymentsDir, "hyperliquid-testnet-deployment.json");
    fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2));

    // Print summary
    console.log("\n=====================================");
    console.log("🎉 DEPLOYMENT SUCCESSFUL!");
    console.log("=====================================\n");
    console.log("📋 Contract Addresses:");
    console.log("   MerkleVerifier:     ", merkleVerifier.address);
    console.log("   MultiTokenTreasury: ", treasury.address);
    console.log("   MockUSDC:           ", mockUSDC.address);
    console.log("\n🔍 View on Block Explorer:");
    console.log("   Purrsec:    https://testnet.purrsec.com/address/" + treasury.address);
    console.log("   Hyperstats: https://evm.hyperstats.xyz/address/" + treasury.address);
    console.log("\n📁 Deployment info saved to:", filePath);

    console.log("\n⚠️  NEXT STEPS:");
    console.log("1. Update node/.env with:");
    console.log(`   HYPERLIQUID_TESTNET_TREASURY_ADDRESS=${treasury.address}`);
    console.log(`   DEFAULT_ADMIN_ADDRESS=${deployerAddress}`);
    console.log("\n2. Add MockUSDC to treasury as supported token:");
    console.log("   Call addToken() with MockUSDC address");
    console.log("\n3. Fund the treasury with HYPE for operations");
    console.log("\n4. Pre-generate keys using the backend admin API");
    console.log("\n5. Test cross-chain withdrawals between different testnets");

  } catch (error) {
    console.error("\n❌ Deployment failed:", error.message);
    console.error(error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
