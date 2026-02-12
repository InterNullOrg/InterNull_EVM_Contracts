const { ethers } = require("hardhat");

async function main() {
  console.log("Deploying Multi-Token Treasury...");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  // Deploy main treasury contract (libraries are linked at compile time)
  console.log("\n1. Deploying MultiTokenTreasury...");
  const Treasury = await ethers.getContractFactory("MultiTokenTreasury");

  const treasury = await Treasury.deploy(deployer.address);
  await treasury.deployed();
  console.log("MultiTokenTreasury deployed to:", treasury.address);

  // Add USDT and USDC support (mock addresses for testing)
  console.log("\n5. Adding token support...");

  // For mainnet, use real token addresses
  const TOKENS = {
    USDT: {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // Mainnet USDT
      symbol: "USDT",
      decimals: 6,
      denominations: [
        ethers.utils.parseUnits("10", 6),
        ethers.utils.parseUnits("50", 6),
        ethers.utils.parseUnits("100", 6),
        ethers.utils.parseUnits("500", 6),
        ethers.utils.parseUnits("1000", 6)
      ]
    },
    USDC: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Mainnet USDC
      symbol: "USDC",
      decimals: 6,
      denominations: [
        ethers.utils.parseUnits("10", 6),
        ethers.utils.parseUnits("50", 6),
        ethers.utils.parseUnits("100", 6),
        ethers.utils.parseUnits("500", 6),
        ethers.utils.parseUnits("1000", 6)
      ]
    }
  };

  // Only add tokens on mainnet/testnet (not on local hardhat network)
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 31337) {
    for (const [name, config] of Object.entries(TOKENS)) {
      try {
        await treasury.addToken(
          config.address,
          config.symbol,
          config.decimals,
          config.denominations
        );
        console.log(`Added ${name} support`);
      } catch (error) {
        console.log(`Skipping ${name}: ${error.message}`);
      }
    }
  }

  // Get initial configuration
  console.log("\n2. Deployment Summary:");
  console.log("========================");
  console.log("Treasury Address:", treasury.address);
  console.log("Owner:", await treasury.owner());

  const supportedTokens = await treasury.getSupportedTokens();
  console.log("\nSupported Tokens:");
  for (let i = 0; i < supportedTokens.tokens.length; i++) {
    const token = supportedTokens.tokens[i];
    const symbol = supportedTokens.symbols[i];
    const decimals = supportedTokens.decimals[i];
    const active = supportedTokens.active[i];

    console.log(`- ${symbol}: ${token === ethers.constants.AddressZero ? "Native ETH" : token}`);
    console.log(`  Decimals: ${decimals}, Active: ${active}`);

    const denominations = await treasury.getTokenDenominations(token);
    console.log(`  Denominations: ${denominations.map(d => ethers.utils.formatUnits(d, decimals)).join(", ")}`);
  }

  // Save deployment info
  const deploymentInfo = {
    network: network.name,
    chainId: network.chainId,
    treasury: treasury.address,
    deployer: deployer.address,
    timestamp: new Date().toISOString()
  };

  const fs = require("fs");
  fs.writeFileSync(
    `./deployments/multitoken-${network.chainId}.json`,
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("\n✅ Deployment complete!");
  console.log(`Deployment info saved to deployments/multitoken-${network.chainId}.json`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });