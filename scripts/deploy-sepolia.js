const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("=====================================");
  console.log("Deploying to Sepolia Testnet");
  console.log("=====================================\n");

  // Get the deployer account
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log("Deployer address:", deployerAddress);

  // Check balance
  const balance = await deployer.getBalance();
  const balanceInEth = hre.ethers.utils.formatEther(balance);
  console.log("Deployer balance:", balanceInEth, "ETH");

  if (balance.eq(0)) {
    console.error("\n❌ ERROR: Deployer has no ETH!");
    console.log("\n📝 Get free Sepolia ETH from:");
    console.log("   - https://sepoliafaucet.com (Alchemy)");
    console.log("   - https://www.infura.io/faucet/sepolia");
    console.log("   - https://faucets.chain.link/sepolia");
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
    const mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);
    await mockUSDC.deployed();
    // Mint initial supply to deployer
    const initialSupply = hre.ethers.utils.parseUnits("1000000", 6); // 1M USDC
    await mockUSDC.mint(deployerAddress, initialSupply);
    console.log("   ✅ MockUSDC deployed to:", mockUSDC.address);
    console.log("   ✅ Initial supply: 1,000,000 USDC minted to deployer");

    // 4. Configure relayer
    console.log("\n4. Configuring relayer...");
    const RELAYER_WALLETS = [
      { name: "Node 1", address: "0x300Fc5016AE0307f995C638AA756b050E9c67A18" },
      { name: "Node 2", address: "0x09970187A9c10AAC713E9bD95b9b1e55656a5Bd1" },
      { name: "Node 3", address: "0xA834cDCC124C340A4CAcBAEBb6F17b318C755448" },
    ];

    for (const wallet of RELAYER_WALLETS) {
      const tx = await treasury.authorizeRelayer(wallet.address, true);
      await tx.wait();
      console.log(`   ✅ Authorized relayer: ${wallet.name} (${wallet.address})`);
    }

    // Set protocol fee to 0.5% (50 basis points)
    const feeTx = await treasury.setProtocolFee(50);
    await feeTx.wait();
    console.log("   ✅ Protocol fee set to 0.5% (50 bps)");

    // Set max gas price cap to 100 gwei
    const capTx = await treasury.setMaxGasPriceCap(hre.ethers.utils.parseUnits("100", "gwei"));
    await capTx.wait();
    console.log("   ✅ Max gas price cap set to 100 gwei");

    // Save deployment info
    const deploymentInfo = {
      network: "sepolia",
      chainId: 11155111,
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
        MerkleVerifier: `https://sepolia.etherscan.io/address/${merkleVerifier.address}`,
        MultiTokenTreasury: `https://sepolia.etherscan.io/address/${treasury.address}`,
        MockUSDC: `https://sepolia.etherscan.io/address/${mockUSDC.address}`
      },
      relayer: {
        authorizedRelayers: RELAYER_WALLETS.map(w => w.address),
        protocolFeeBps: 50,
        maxGasPriceCapGwei: 100
      }
    };

    // Save to file
    const deploymentsDir = path.join(__dirname, "../deployments");
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const filePath = path.join(deploymentsDir, "sepolia-deployment.json");
    fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2));

    // Print summary
    console.log("\n=====================================");
    console.log("🎉 DEPLOYMENT SUCCESSFUL!");
    console.log("=====================================\n");
    console.log("📋 Contract Addresses:");
    console.log("   MerkleVerifier:     ", merkleVerifier.address);
    console.log("   MultiTokenTreasury: ", treasury.address);
    console.log("   MockUSDC:           ", mockUSDC.address);
    console.log("\n🔍 View on Etherscan:");
    console.log("   Treasury: https://sepolia.etherscan.io/address/" + treasury.address);
    console.log("\n📁 Deployment info saved to:", filePath);

    console.log("\n⚠️  NEXT STEPS:");
    console.log("1. Update .env files with new contract address:");
    console.log(`   REACT_APP_TREASURY_CONTRACT=${treasury.address}`);
    console.log("\n2. Update node1.yaml admin treasury_contract:");
    console.log(`   treasury_contract: "${treasury.address}"`);
    console.log("\n3. Copy updated ABI to frontend src/contracts/");
    console.log("\n4. Fund relayer wallets with Sepolia ETH:");
    for (const w of RELAYER_WALLETS) {
      console.log(`   ${w.name}: ${w.address}`);
    }
    console.log("\n5. Fund the treasury contract with Sepolia ETH");
    console.log("\n6. Verify on Etherscan (optional):");
    console.log(`   npx hardhat verify --network sepolia ${treasury.address} ${deployerAddress}`);

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