const hre = require("hardhat");

async function main() {
    const [signer] = await hre.ethers.getSigners();
    console.log("Adding merkle root with account:", signer.address);

    // Get the deployed contract address
    const treasuryAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

    // Get the contract
    const Treasury = await hre.ethers.getContractFactory("MultiTokenTreasury");
    const treasury = Treasury.attach(treasuryAddress);

    // The merkle root from the database
    const merkleRoot = "0x446993193d472b32567e2cb0f144f20e8d5f9a366e4b720b67664d58f5ad8932";

    // Token address (0x0 for ETH)
    const tokenAddress = "0x0000000000000000000000000000000000000000";

    // Denomination in wei (1 ETH = 1000000000000000000 wei)
    const denomination = hre.ethers.utils.parseEther("1.0");

    // Total keys in this batch (256 keys for a batch)
    const totalKeys = 256;

    try {
        console.log("Adding merkle root:", merkleRoot);
        console.log("Token:", tokenAddress, "(ETH)");
        console.log("Denomination:", hre.ethers.utils.formatEther(denomination), "ETH");
        console.log("Total keys:", totalKeys);

        const tx = await treasury.addMerkleRoot(merkleRoot, tokenAddress, denomination, totalKeys);
        console.log("Transaction sent:", tx.hash);

        const receipt = await tx.wait();
        console.log("Merkle root added successfully!");
        console.log("Gas used:", receipt.gasUsed.toString());

        // Get the merkle root ID (it should be 0 for the first one)
        const count = await treasury.getCurrentMerkleRootCount();
        console.log("Total merkle roots:", count.toString());
        console.log("New merkle root ID:", (count - 1).toString());

    } catch (error) {
        console.error("Error adding merkle root:", error);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });