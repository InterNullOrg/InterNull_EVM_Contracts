const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("=====================================");
  console.log("Deploying to Polygon Amoy Testnet");
  console.log("=====================================\n");

  // Get the deployer account
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log("Deployer address:", deployerAddress);

  // Check balance
  const balance = await deployer.getBalance();
  const balanceInMatic = hre.ethers.utils.formatEther(balance);
  console.log("Deployer balance:", balanceInMatic, "MATIC");

  if (balance.eq(0)) {
    console.error("\n❌ ERROR: Deployer has no MATIC!");
    console.log("\n📝 Get free Polygon Amoy MATIC from:");
    console.log("   - https://faucet.polygon.technology (Official Polygon Faucet)");
    console.log("   - https://www.alchemy.com/faucets/polygon-amoy");
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

    // 2. Deploy MultiTokenTreasury
    console.log("\n2. Deploying MultiTokenTreasury contract...");
    const MultiTokenTreasury = await hre.ethers.getContractFactory("MultiTokenTreasury");

    // Deploy with the deployer address as owner
    const treasury = await MultiTokenTreasury.deploy(deployerAddress);
    await treasury.deployed();
    console.log("   ✅ MultiTokenTreasury deployed to:", treasury.address);
    console.log("   ✅ Admin set to:", deployerAddress);

    // 3. Deploy MockERC20 tokens for testing
    console.log("\n3. Deploying MockERC20 tokens for testing...");
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    const initialSupply = hre.ethers.utils.parseUnits("1000000", 6); // 1M tokens

    // Deploy Mock USDC
    const mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);
    await mockUSDC.deployed();
    await (await mockUSDC.mint(deployerAddress, initialSupply)).wait();
    console.log("   ✅ MockUSDC deployed to:", mockUSDC.address);

    // Deploy Mock USDT
    const mockUSDT = await MockERC20.deploy("Mock USDT", "USDT", 6);
    await mockUSDT.deployed();
    await (await mockUSDT.mint(deployerAddress, initialSupply)).wait();
    console.log("   ✅ MockUSDT deployed to:", mockUSDT.address);
    console.log("   ✅ Initial supply: 1,000,000 tokens minted to deployer for each");

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

    // Set max gas price cap to 50 gwei for Polygon
    const capTx = await treasury.setMaxGasPriceCap(hre.ethers.utils.parseUnits("50", "gwei"));
    await capTx.wait();
    console.log("   ✅ Max gas price cap set to 50 gwei");

    // Save deployment info
    const deploymentInfo = {
      network: "amoy",
      chainId: 80002,
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
        },
        MockUSDT: {
          address: mockUSDT.address,
          type: "test-token",
          decimals: 6
        }
      },
      blockExplorer: {
        MerkleVerifier: `https://amoy.polygonscan.com/address/${merkleVerifier.address}`,
        MultiTokenTreasury: `https://amoy.polygonscan.com/address/${treasury.address}`,
        MockUSDC: `https://amoy.polygonscan.com/address/${mockUSDC.address}`,
        MockUSDT: `https://amoy.polygonscan.com/address/${mockUSDT.address}`
      },
      relayer: {
        authorizedRelayers: RELAYER_WALLETS.map(w => w.address),
        protocolFeeBps: 50,
        maxGasPriceCapGwei: 50
      }
    };

    // Save to file
    const deploymentsDir = path.join(__dirname, "../deployments");
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const filePath = path.join(deploymentsDir, "amoy-deployment.json");
    fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2));

    // Print summary
    console.log("\n=====================================");
    console.log("🎉 DEPLOYMENT SUCCESSFUL!");
    console.log("=====================================\n");
    console.log("📋 Contract Addresses:");
    console.log("   MerkleVerifier:     ", merkleVerifier.address);
    console.log("   MultiTokenTreasury: ", treasury.address);
    console.log("   MockUSDC:           ", mockUSDC.address);
    console.log("   MockUSDT:           ", mockUSDT.address);
    console.log("\n🔍 View on PolygonScan:");
    console.log("   Treasury: https://amoy.polygonscan.com/address/" + treasury.address);
    console.log("\n📁 Deployment info saved to:", filePath);

    console.log("\n⚠️  NEXT STEPS:");
    console.log("1. Update frontend .env with:");
    console.log(`   REACT_APP_TREASURY_CONTRACT=${treasury.address}`);
    console.log(`   REACT_APP_MERKLE_VERIFIER=${merkleVerifier.address}`);
    console.log("\n2. Update node config with:");
    console.log(`   POLYGON_AMOY_TREASURY_ADDRESS=${treasury.address}`);
    console.log(`   DEFAULT_ADMIN_ADDRESS=${deployerAddress}`);
    console.log("\n3. Fund relayer wallets with Amoy MATIC:");
    for (const w of RELAYER_WALLETS) {
      console.log(`   ${w.name}: ${w.address}`);
    }
    console.log("\n4. Verify on PolygonScan (optional):");
    console.log(`   npx hardhat verify --network amoy ${treasury.address} ${deployerAddress}`);

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
