const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("=====================================");
  console.log("Deploying to BNB Testnet");
  console.log("=====================================\n");

  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log("Deployer address:", deployerAddress);

  const balance = await deployer.getBalance();
  console.log("Deployer balance:", hre.ethers.utils.formatEther(balance), "BNB");

  if (balance.eq(0)) {
    console.error("\n❌ ERROR: Deployer has no BNB!");
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
    const treasury = await MultiTokenTreasury.deploy(deployerAddress);
    await treasury.deployed();
    console.log("   ✅ MultiTokenTreasury deployed to:", treasury.address);
    console.log("   ✅ Admin set to:", deployerAddress);

    // 3. Deploy MockERC20 for BUSD testing
    console.log("\n3. Deploying MockERC20 (BUSD) for testing...");
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    const mockBUSD = await MockERC20.deploy("Mock BUSD", "BUSD", 18);
    await mockBUSD.deployed();
    const initialSupply = hre.ethers.utils.parseUnits("1000000", 18);
    await mockBUSD.mint(deployerAddress, initialSupply);
    console.log("   ✅ MockBUSD deployed to:", mockBUSD.address);
    console.log("   ✅ Initial supply: 1,000,000 BUSD minted to deployer");

    // 4. Configure relayers and fees
    console.log("\n4. Configuring relayers and fees...");
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

    const feeTx = await treasury.setProtocolFee(50);
    await feeTx.wait();
    console.log("   ✅ Protocol fee set to 0.5% (50 bps)");

    const capTx = await treasury.setMaxGasPriceCap(hre.ethers.utils.parseUnits("20", "gwei"));
    await capTx.wait();
    console.log("   ✅ Max gas price cap set to 20 gwei");

    // 5. Add 0.001 BNB denomination (constructor registers 0.01, 0.1, 0.5, 1)
    console.log("\n5. Adding 0.001 BNB denomination...");
    const denomTx = await treasury.updateDenominations(
      "0x0000000000000000000000000000000000000000",
      [hre.ethers.utils.parseEther("0.001")]
    );
    await denomTx.wait();
    console.log("   ✅ Added 0.001 BNB denomination");

    // Save deployment info
    const deploymentInfo = {
      network: "bnb_testnet",
      chainId: 97,
      deployer: deployerAddress,
      timestamp: new Date().toISOString(),
      contracts: {
        MerkleVerifier: { address: merkleVerifier.address, type: "library" },
        MultiTokenTreasury: { address: treasury.address, type: "main", admin: deployerAddress },
        MockBUSD: { address: mockBUSD.address, type: "test-token", decimals: 18 }
      },
      blockExplorer: {
        MerkleVerifier: `https://testnet.bscscan.com/address/${merkleVerifier.address}`,
        MultiTokenTreasury: `https://testnet.bscscan.com/address/${treasury.address}`,
        MockBUSD: `https://testnet.bscscan.com/address/${mockBUSD.address}`
      },
      relayer: {
        authorizedRelayers: RELAYER_WALLETS.map(w => w.address),
        protocolFeeBps: 50,
        maxGasPriceCapGwei: 20
      }
    };

    const deploymentsDir = path.join(__dirname, "../deployments");
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const filePath = path.join(deploymentsDir, "bnb-testnet-deployment.json");
    fs.writeFileSync(filePath, JSON.stringify(deploymentInfo, null, 2));

    console.log("\n=====================================");
    console.log("🎉 DEPLOYMENT SUCCESSFUL!");
    console.log("=====================================\n");
    console.log("📋 Contract Addresses:");
    console.log("   MerkleVerifier:     ", merkleVerifier.address);
    console.log("   MultiTokenTreasury: ", treasury.address);
    console.log("   MockBUSD:           ", mockBUSD.address);
    console.log("\n🔍 View on BscScan:");
    console.log("   Treasury: https://testnet.bscscan.com/address/" + treasury.address);
    console.log("\n📁 Deployment info saved to:", filePath);

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
