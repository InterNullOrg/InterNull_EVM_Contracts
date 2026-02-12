const hre = require("hardhat");

async function main() {
  console.log("=====================================");
  console.log("Adding 0.001 ETH Denomination to Base Sepolia");
  console.log("=====================================\n");

  // Get the deployer account
  const [deployer] = await hre.ethers.getSigners();
  const deployerAddress = await deployer.getAddress();

  console.log("Admin address:", deployerAddress);

  // Treasury contract address from deployment
  const TREASURY_ADDRESS = "0x39Ff2ad0589Ceb82B941Ccb0E85d59A7806B471D";

  // ETH token address (0x0 for native ETH)
  const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

  // 0.001 ETH in wei
  const DENOMINATION = hre.ethers.utils.parseEther("0.001");

  console.log("Treasury contract:", TREASURY_ADDRESS);
  console.log("Token (ETH):", ETH_ADDRESS);
  console.log("Denomination: 0.001 ETH =", DENOMINATION.toString(), "wei\n");

  try {
    // Get the contract instance
    const Treasury = await hre.ethers.getContractFactory("MultiTokenTreasury");
    const treasury = Treasury.attach(TREASURY_ADDRESS);

    // Check current denominations
    console.log("Fetching current denominations for ETH...");
    const currentDenoms = await treasury.getTokenDenominations(ETH_ADDRESS);
    console.log("Current denominations (in wei):");
    currentDenoms.forEach((denom, index) => {
      const ethValue = hre.ethers.utils.formatEther(denom);
      console.log(`  ${index + 1}. ${denom.toString()} wei (${ethValue} ETH)`);
    });

    // Check if 0.001 ETH already exists
    const exists = currentDenoms.some(d => d.toString() === DENOMINATION.toString());

    if (exists) {
      console.log("\n✓ 0.001 ETH denomination already exists in the contract!");
      console.log("No action needed.");
      return;
    }

    console.log("\n⚠️  0.001 ETH denomination NOT found in contract.");
    console.log("Adding it now...\n");

    // Add the denomination using updateDenominations (takes an array)
    const tx = await treasury.updateDenominations(ETH_ADDRESS, [DENOMINATION]);
    console.log("Transaction sent:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log("✓ Transaction confirmed in block:", receipt.blockNumber);

    // Verify it was added
    console.log("\nVerifying...");
    const updatedDenoms = await treasury.getTokenDenominations(ETH_ADDRESS);
    console.log("Updated denominations (in wei):");
    updatedDenoms.forEach((denom, index) => {
      const ethValue = hre.ethers.utils.formatEther(denom);
      console.log(`  ${index + 1}. ${denom.toString()} wei (${ethValue} ETH)`);
    });

    console.log("\n=====================================");
    console.log("✓ SUCCESS!");
    console.log("=====================================");
    console.log("\n0.001 ETH denomination has been added to Base Sepolia treasury!");
    console.log("\nView on BaseScan:");
    console.log(`https://sepolia.basescan.org/tx/${tx.hash}`);

  } catch (error) {
    console.error("\n❌ Failed to add denomination:", error.message);
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
