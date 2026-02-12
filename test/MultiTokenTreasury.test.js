const { expect } = require("chai");
const { ethers } = require("hardhat");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

describe("MultiTokenTreasury", function () {
  let treasury;
  let mockUSDT, mockUSDC;
  let owner, user1, user2, recipient;
  let merkleTree;
  let merkleRoot;
  let privateKeys = [];
  let publicKeys = [];

  // Helper function to generate keys
  function generateKeys(count, denomination) {
    const keys = [];
    for (let i = 0; i < count; i++) {
      const wallet = ethers.Wallet.createRandom();
      keys.push({
        privateKey: wallet.privateKey,
        publicKey: wallet.address,
        denomination: denomination,
        index: i
      });
      privateKeys.push(wallet.privateKey);
      publicKeys.push(wallet.address);
    }
    return keys;
  }

  // Helper function to create merkle tree
  function createMerkleTree(addresses) {
    const leaves = addresses.map(addr =>
      keccak256(ethers.utils.solidityPack(["address"], [addr]))
    );
    return new MerkleTree(leaves, keccak256, { sortPairs: false });
  }

  // Helper function to sign withdrawal (abi.encode format matching contract)
  async function signWithdrawal(privateKey, recipient, token, amount, merkleRootId, keyIndex) {
    const wallet = new ethers.Wallet(privateKey);
    const chainId = await ethers.provider.getNetwork().then(n => n.chainId);

    const encoded = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint256", "uint256", "uint256", "uint256"],
      [recipient, token, amount, merkleRootId, keyIndex, chainId]
    );
    const messageHash = ethers.utils.keccak256(encoded);

    return wallet.signMessage(ethers.utils.arrayify(messageHash));
  }

  beforeEach(async function () {
    [owner, user1, user2, recipient] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUSDT = await MockERC20.deploy("Mock USDT", "USDT", 6);
    mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);

    // Mint tokens to users
    await mockUSDT.mint(user1.address, ethers.utils.parseUnits("10000", 6));
    await mockUSDT.mint(user2.address, ethers.utils.parseUnits("10000", 6));
    await mockUSDC.mint(user1.address, ethers.utils.parseUnits("10000", 6));
    await mockUSDC.mint(user2.address, ethers.utils.parseUnits("10000", 6));

    // Deploy treasury (libraries are inlined by compiler, no linking needed)
    const Treasury = await ethers.getContractFactory("MultiTokenTreasury");
    treasury = await Treasury.deploy(owner.address);
    await treasury.deployed();

    // Generate keys and merkle tree
    privateKeys = [];
    publicKeys = [];
    generateKeys(4, ethers.utils.parseEther("0.1"));
    generateKeys(4, ethers.utils.parseEther("0.5"));
    generateKeys(2, ethers.utils.parseEther("1"));

    merkleTree = createMerkleTree(publicKeys);
    merkleRoot = merkleTree.getHexRoot();
  });

  describe("Token Management", function () {
    it("Should deploy with ETH support by default", async function () {
      const tokens = await treasury.getSupportedTokens();
      expect(tokens.tokens.length).to.equal(1);
      expect(tokens.tokens[0]).to.equal(ethers.constants.AddressZero);
      expect(tokens.symbols[0]).to.equal("ETH");
      expect(tokens.decimals[0]).to.equal(18);
      expect(tokens.active[0]).to.be.true;
    });

    it("Should add ERC20 tokens with correct parameters", async function () {
      const denominations = [
        ethers.utils.parseUnits("10", 6),
        ethers.utils.parseUnits("50", 6),
        ethers.utils.parseUnits("100", 6),
        ethers.utils.parseUnits("500", 6)
      ];

      await treasury.addToken(
        mockUSDT.address,
        "USDT",
        6,
        denominations
      );

      const tokenInfo = await treasury.tokenInfo(mockUSDT.address);
      expect(tokenInfo.symbol).to.equal("USDT");
      expect(tokenInfo.decimals).to.equal(6);
      expect(tokenInfo.isActive).to.be.true;

      const tokenDenoms = await treasury.getTokenDenominations(mockUSDT.address);
      expect(tokenDenoms.length).to.equal(4);
      expect(tokenDenoms[0]).to.equal(denominations[0]);
    });

    it("Should reject invalid denomination configurations", async function () {
      // Duplicate denominations
      await expect(
        treasury.addToken(
          mockUSDT.address,
          "USDT",
          6,
          [100, 100, 200]
        )
      ).to.be.reverted;

      // Empty denominations
      await expect(
        treasury.addToken(
          mockUSDT.address,
          "USDT",
          6,
          []
        )
      ).to.be.reverted;

      // Zero denomination
      await expect(
        treasury.addToken(
          mockUSDT.address,
          "USDT",
          6,
          [0, 100, 200]
        )
      ).to.be.reverted;
    });

    it("Should verify token decimals match", async function () {
      // Try to add USDT with wrong decimals
      await expect(
        treasury.addToken(
          mockUSDT.address,
          "USDT",
          18, // Wrong decimals (should be 6)
          [100, 200]
        )
      ).to.be.revertedWith("Decimal mismatch");
    });

    it("Should deactivate tokens", async function () {
      const denominations = [100, 500, 1000];
      await treasury.addToken(mockUSDT.address, "USDT", 6, denominations);

      await treasury.removeToken(mockUSDT.address);

      const tokenInfo = await treasury.tokenInfo(mockUSDT.address);
      expect(tokenInfo.isActive).to.be.false;

      // Should not be able to deposit after removal
      await mockUSDT.connect(user1).approve(treasury.address, 100);
      await expect(
        treasury.connect(user1).deposit(mockUSDT.address, 100)
      ).to.be.reverted;
    });
  });

  describe("Merkle Root Management", function () {
    it("Should add merkle roots correctly", async function () {
      const token = ethers.constants.AddressZero;
      const denomination = ethers.utils.parseEther("0.1");

      await treasury.addMerkleRoot(merkleRoot, token, denomination, publicKeys.length);

      const rootInfo = await treasury.merkleRoots(0);
      expect(rootInfo.root).to.equal(merkleRoot);
      expect(rootInfo.token).to.equal(token);
      expect(rootInfo.denomination).to.equal(denomination);
      expect(rootInfo.isActive).to.be.true;
      expect(rootInfo.totalKeys).to.equal(publicKeys.length);
      expect(rootInfo.usedKeys).to.equal(0);
    });

    it("Should find merkle root ID by hash", async function () {
      await treasury.addMerkleRoot(merkleRoot, ethers.constants.AddressZero, ethers.utils.parseEther("0.1"), publicKeys.length);

      const [found, rootId] = await treasury.getMerkleRootIdByHash(merkleRoot);
      expect(found).to.be.true;
      expect(rootId).to.equal(0);

      // Test with non-existent root
      const fakeRoot = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("fake"));
      const [notFound, ] = await treasury.getMerkleRootIdByHash(fakeRoot);
      expect(notFound).to.be.false;
    });

    it("Should get active merkle roots with pagination", async function () {
      // Add multiple merkle roots
      for (let i = 0; i < 5; i++) {
        const keys = generateKeys(2, ethers.utils.parseEther("0.1"));
        const tree = createMerkleTree(keys.map(k => k.publicKey));
        await treasury.addMerkleRoot(tree.getHexRoot(), ethers.constants.AddressZero, ethers.utils.parseEther("0.1"), keys.length);
      }

      // Get first page
      const [page1, total1] = await treasury.getActiveMerkleRoots(0, 3);
      expect(page1.length).to.equal(3);
      expect(total1).to.equal(5);

      // Get second page
      const [page2, total2] = await treasury.getActiveMerkleRoots(3, 3);
      expect(page2.length).to.equal(2);
      expect(total2).to.equal(5);
    });

    it("Should deactivate merkle roots", async function () {
      await treasury.addMerkleRoot(merkleRoot, ethers.constants.AddressZero, ethers.utils.parseEther("0.1"), publicKeys.length);
      await treasury.deactivateMerkleRoot(0);

      const rootInfo = await treasury.merkleRoots(0);
      expect(rootInfo.isActive).to.be.false;
    });

    it("Should allow up to 1000 merkle roots (cap raised from 100)", async function () {
      // Add 100 roots (well under the 1000 cap)
      for (let i = 0; i < 100; i++) {
        const keys = generateKeys(1, ethers.utils.parseEther("0.1"));
        const tree = createMerkleTree(keys.map(k => k.publicKey));
        await treasury.addMerkleRoot(tree.getHexRoot(), ethers.constants.AddressZero, ethers.utils.parseEther("0.1"), keys.length);
      }

      // 101st root should succeed (cap is 1000, not 100)
      const extraKeys = generateKeys(1, ethers.utils.parseEther("0.1"));
      const extraTree = createMerkleTree(extraKeys.map(k => k.publicKey));
      await expect(
        treasury.addMerkleRoot(extraTree.getHexRoot(), ethers.constants.AddressZero, ethers.utils.parseEther("0.1"), extraKeys.length)
      ).to.not.be.reverted;
    });
  });

  describe("ETH Deposits and Withdrawals", function () {
    beforeEach(async function () {
      await treasury.addMerkleRoot(merkleRoot, ethers.constants.AddressZero, ethers.utils.parseEther("0.1"), publicKeys.length);
    });

    it("Should deposit ETH with valid denomination", async function () {
      const amount = ethers.utils.parseEther("0.1");

      await expect(
        treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
          value: amount
        })
      ).to.emit(treasury, "Deposit");

      const stats = await treasury.getTokenStats(ethers.constants.AddressZero);
      expect(stats.deposited).to.equal(amount);
      expect(stats.balance).to.equal(amount);
    });

    it("Should accept ETH deposit of any amount (cross-chain compatible)", async function () {
      const amount = ethers.utils.parseEther("0.001"); // Not a standard denomination but allowed

      await expect(
        treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
          value: amount
        })
      ).to.emit(treasury, "Deposit");
    });

    it("Should reject zero-amount deposit", async function () {
      await expect(
        treasury.connect(user1).deposit(ethers.constants.AddressZero, 0, {
          value: 0
        })
      ).to.be.reverted;
    });

    it("Should reject ETH deposit with mismatched value", async function () {
      const amount = ethers.utils.parseEther("0.1");

      await expect(
        treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
          value: ethers.utils.parseEther("0.2") // Wrong value
        })
      ).to.be.revertedWith("Incorrect ETH amount");
    });

    it("Should withdraw ETH with valid signature and merkle proof", async function () {
      // Deposit first
      const amount = ethers.utils.parseEther("0.1");
      await treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
        value: amount
      });

      // Prepare withdrawal
      const keyIndex = 0;
      const privateKey = privateKeys[keyIndex];
      const publicKey = publicKeys[keyIndex];

      const signature = await signWithdrawal(
        privateKey,
        recipient.address,
        ethers.constants.AddressZero,
        amount,
        0,
        keyIndex
      );

      const leaf = keccak256(ethers.utils.solidityPack(["address"], [publicKey]));
      const proof = merkleTree.getHexProof(leaf);

      const initialBalance = await recipient.getBalance();

      await expect(
        treasury.withdraw(
          ethers.constants.AddressZero,
          recipient.address,
          amount,
          0, // merkleRootId
          signature,
          proof,
          keyIndex
        )
      ).to.emit(treasury, "Withdrawal");

      // Check recipient received funds (minus fee)
      const finalBalance = await recipient.getBalance();
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should prevent double-spending", async function () {
      // Deposit
      const amount = ethers.utils.parseEther("0.1");
      await treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
        value: amount
      });

      // Prepare withdrawal
      const keyIndex = 0;
      const signature = await signWithdrawal(
        privateKeys[keyIndex],
        recipient.address,
        ethers.constants.AddressZero,
        amount,
        0,
        keyIndex
      );

      const leaf = keccak256(
        ethers.utils.solidityPack(["address"], [publicKeys[keyIndex]])
      );
      const proof = merkleTree.getHexProof(leaf);

      // First withdrawal should succeed
      await treasury.withdraw(
        ethers.constants.AddressZero,
        recipient.address,
        amount,
        0,
        signature,
        proof,
        keyIndex
      );

      // Deposit again for second attempt
      await treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
        value: amount
      });

      // Second withdrawal with same signature should fail
      await expect(
        treasury.withdraw(
          ethers.constants.AddressZero,
          recipient.address,
          amount,
          0,
          signature,
          proof,
          keyIndex
        )
      ).to.be.reverted;
    });
  });

  describe("ERC20 Deposits and Withdrawals", function () {
    beforeEach(async function () {
      // Setup USDT support
      const denominations = [
        ethers.utils.parseUnits("10", 6),
        ethers.utils.parseUnits("50", 6),
        ethers.utils.parseUnits("100", 6),
        ethers.utils.parseUnits("500", 6)
      ];
      await treasury.addToken(mockUSDT.address, "USDT", 6, denominations);
      await treasury.addMerkleRoot(merkleRoot, mockUSDT.address, ethers.utils.parseUnits("100", 6), publicKeys.length);
    });

    it("Should deposit ERC20 tokens", async function () {
      const amount = ethers.utils.parseUnits("100", 6);

      await mockUSDT.connect(user1).approve(treasury.address, amount);

      await expect(
        treasury.connect(user1).deposit(mockUSDT.address, amount)
      ).to.emit(treasury, "Deposit");

      const stats = await treasury.getTokenStats(mockUSDT.address);
      expect(stats.deposited).to.equal(amount);
      expect(stats.balance).to.equal(amount);
    });

    it("Should reject ERC20 deposit without approval", async function () {
      const amount = ethers.utils.parseUnits("100", 6);

      await expect(
        treasury.connect(user1).deposit(mockUSDT.address, amount)
      ).to.be.reverted;
    });

    it("Should reject ERC20 deposit with ETH value", async function () {
      const amount = ethers.utils.parseUnits("100", 6);

      await mockUSDT.connect(user1).approve(treasury.address, amount);

      await expect(
        treasury.connect(user1).deposit(mockUSDT.address, amount, {
          value: ethers.utils.parseEther("0.1")
        })
      ).to.be.revertedWith("ETH sent for token deposit");
    });

    it("Should withdraw ERC20 tokens", async function () {
      // Deposit first
      const amount = ethers.utils.parseUnits("100", 6);
      await mockUSDT.connect(user1).approve(treasury.address, amount);
      await treasury.connect(user1).deposit(mockUSDT.address, amount);

      // Prepare withdrawal
      const keyIndex = 0;
      const signature = await signWithdrawal(
        privateKeys[keyIndex],
        recipient.address,
        mockUSDT.address,
        amount,
        0,
        keyIndex
      );

      const leaf = keccak256(
        ethers.utils.solidityPack(["address"], [publicKeys[keyIndex]])
      );
      const proof = merkleTree.getHexProof(leaf);

      const initialBalance = await mockUSDT.balanceOf(recipient.address);

      await treasury.withdraw(
        mockUSDT.address,
        recipient.address,
        amount,
        0,
        signature,
        proof,
        keyIndex
      );

      const finalBalance = await mockUSDT.balanceOf(recipient.address);
      // Account for fee
      expect(finalBalance.sub(initialBalance)).to.be.closeTo(
        amount,
        ethers.utils.parseUnits("1", 6)
      );
    });
  });

  describe("Getter Functions", function () {
    beforeEach(async function () {
      // Setup multiple tokens
      await treasury.addToken(
        mockUSDT.address,
        "USDT",
        6,
        [ethers.utils.parseUnits("100", 6)]
      );
      await treasury.addToken(
        mockUSDC.address,
        "USDC",
        6,
        [ethers.utils.parseUnits("100", 6)]
      );
    });

    it("Should get all supported tokens", async function () {
      const result = await treasury.getSupportedTokens();
      expect(result.tokens.length).to.equal(3); // ETH + USDT + USDC
      expect(result.symbols).to.deep.equal(["ETH", "USDT", "USDC"]);
    });

    it("Should validate denominations", async function () {
      const validAmount = ethers.utils.parseUnits("100", 6);
      const invalidAmount = ethers.utils.parseUnits("150", 6);

      expect(await treasury.isValidDenomination(mockUSDT.address, validAmount))
        .to.be.true;
      expect(await treasury.isValidDenomination(mockUSDT.address, invalidAmount))
        .to.be.false;
    });

    it("Should check nullifiers in batch", async function () {
      const nullifiers = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("nullifier1")),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("nullifier2")),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("nullifier3"))
      ];

      const results = await treasury.checkNullifiers(nullifiers);
      expect(results).to.deep.equal([false, false, false]);
    });

    it("Should get withdrawal capacity", async function () {
      // Deposit some ETH
      const amount = ethers.utils.parseEther("1");
      await treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
        value: amount
      });

      const [available, percent] = await treasury.getWithdrawalCapacity(
        ethers.constants.AddressZero
      );

      // Should be able to withdraw 90% minus reserve
      expect(available).to.be.gt(0);
      expect(percent).to.be.lte(9000); // <= 90%
    });

    it("Should get token stats", async function () {
      const amount = ethers.utils.parseUnits("100", 6);
      await mockUSDT.connect(user1).approve(treasury.address, amount);
      await treasury.connect(user1).deposit(mockUSDT.address, amount);

      const stats = await treasury.getTokenStats(mockUSDT.address);
      expect(stats.deposited).to.equal(amount);
      expect(stats.withdrawn).to.equal(0);
      expect(stats.balance).to.equal(amount);
      expect(stats.fees).to.equal(0);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to pause/unpause", async function () {
      await treasury.pause();

      const amount = ethers.utils.parseEther("0.1");
      await expect(
        treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
          value: amount
        })
      ).to.be.revertedWith("Pausable: paused");

      await treasury.unpause();

      await expect(
        treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
          value: amount
        })
      ).to.not.be.reverted;
    });

    it("Should allow emergency withdrawal when paused", async function () {
      // Deposit some funds
      const amount = ethers.utils.parseEther("1");
      await treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
        value: amount
      });

      // Pause and emergency withdraw
      await treasury.pause();

      const ownerBalanceBefore = await owner.getBalance();
      await treasury.emergencyWithdraw(ethers.constants.AddressZero, amount);
      const ownerBalanceAfter = await owner.getBalance();

      expect(ownerBalanceAfter.sub(ownerBalanceBefore)).to.be.closeTo(
        amount,
        ethers.utils.parseEther("0.01") // Gas costs
      );
    });

    it("Should not allow emergency withdrawal when not paused", async function () {
      const amount = ethers.utils.parseEther("1");

      await expect(
        treasury.emergencyWithdraw(ethers.constants.AddressZero, amount)
      ).to.be.revertedWith("Pausable: not paused");
    });

    it("Should withdraw collected fees", async function () {
      // Set protocol fee so fees are collected on withdrawal
      await treasury.setProtocolFee(50); // 0.5%

      const usdtDenoms = [ethers.utils.parseUnits("100", 6)];
      await treasury.addToken(mockUSDT.address, "USDT", 6, usdtDenoms);
      await treasury.addMerkleRoot(merkleRoot, mockUSDT.address, ethers.utils.parseUnits("100", 6), publicKeys.length);

      // Deposit ERC20
      const amount = ethers.utils.parseUnits("100", 6);
      await mockUSDT.connect(user1).approve(treasury.address, amount);
      await treasury.connect(user1).deposit(mockUSDT.address, amount);

      // Withdraw to generate fees
      const keyIndex = 0;
      const signature = await signWithdrawal(
        privateKeys[keyIndex],
        recipient.address,
        mockUSDT.address,
        amount,
        0,
        keyIndex
      );

      const leaf = keccak256(
        ethers.utils.solidityPack(["address"], [publicKeys[keyIndex]])
      );
      const proof = merkleTree.getHexProof(leaf);

      await treasury.withdraw(
        mockUSDT.address,
        recipient.address,
        amount,
        0,
        signature,
        proof,
        keyIndex
      );

      // Verify fees were collected
      const stats = await treasury.getTokenStats(mockUSDT.address);
      expect(stats.fees).to.be.gt(0);

      // Withdraw fees to owner
      await expect(treasury.withdrawFees(mockUSDT.address))
        .to.emit(treasury, "FeesWithdrawn");
    });
  });

  describe("Gas Optimization Tests", function () {
    it("Should efficiently handle batch operations", async function () {
      // Setup multiple deposits
      const amounts = [
        ethers.utils.parseEther("0.1"),
        ethers.utils.parseEther("0.5"),
        ethers.utils.parseEther("1")
      ];

      for (let amount of amounts) {
        const tx = await treasury.connect(user1).deposit(
          ethers.constants.AddressZero,
          amount,
          { value: amount }
        );
        const receipt = await tx.wait();
        console.log(`Deposit ${ethers.utils.formatEther(amount)} ETH - Gas: ${receipt.gasUsed.toString()}`);
      }
    });

    it("Should efficiently check multiple nullifiers", async function () {
      const nullifiers = [];
      for (let i = 0; i < 20; i++) {
        nullifiers.push(
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`nullifier${i}`))
        );
      }

      const tx = await treasury.checkNullifiers(nullifiers);
      console.log(`Check 20 nullifiers - Gas estimate: ${await treasury.estimateGas.checkNullifiers(nullifiers)}`);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle maximum denomination values", async function () {
      const maxAmount = ethers.utils.parseEther("1000");
      await treasury.addToken(
        mockUSDT.address,
        "USDT",
        6,
        [ethers.utils.parseUnits("1000000", 6)] // 1M USDT
      );

      const amount = ethers.utils.parseUnits("1000000", 6);
      await mockUSDT.mint(user1.address, amount);
      await mockUSDT.connect(user1).approve(treasury.address, amount);

      await expect(
        treasury.connect(user1).deposit(mockUSDT.address, amount)
      ).to.not.be.reverted;
    });

    it("Should prevent withdrawal when liquidity is too low", async function () {
      await treasury.addMerkleRoot(merkleRoot, ethers.constants.AddressZero, ethers.utils.parseEther("0.1"), publicKeys.length);

      // Try to withdraw without deposits (only MIN_LIQUIDITY_RESERVE exists)
      const amount = ethers.utils.parseEther("0.1");

      const keyIndex = 0;
      const signature = await signWithdrawal(
        privateKeys[keyIndex],
        recipient.address,
        ethers.constants.AddressZero,
        amount,
        0,
        keyIndex
      );

      const leaf = keccak256(
        ethers.utils.solidityPack(["address"], [publicKeys[keyIndex]])
      );
      const proof = merkleTree.getHexProof(leaf);

      await expect(
        treasury.withdraw(
          ethers.constants.AddressZero,
          recipient.address,
          amount,
          0,
          signature,
          proof,
          keyIndex
        )
      ).to.be.reverted;
    });

    it("Should handle invalid merkle proofs", async function () {
      await treasury.addMerkleRoot(merkleRoot, ethers.constants.AddressZero, ethers.utils.parseEther("0.1"), publicKeys.length);

      // Deposit
      const amount = ethers.utils.parseEther("0.1");
      await treasury.connect(user1).deposit(ethers.constants.AddressZero, amount, {
        value: amount
      });

      const keyIndex = 0;
      const signature = await signWithdrawal(
        privateKeys[keyIndex],
        recipient.address,
        ethers.constants.AddressZero,
        amount,
        0,
        keyIndex
      );

      // Use wrong proof
      const wrongLeaf = keccak256(
        ethers.utils.solidityPack(["address"], [recipient.address])
      );
      const wrongProof = merkleTree.getHexProof(wrongLeaf);

      await expect(
        treasury.withdraw(
          ethers.constants.AddressZero,
          recipient.address,
          amount,
          0,
          signature,
          wrongProof,
          keyIndex
        )
      ).to.be.revertedWith("Invalid merkle proof");
    });
  });
});

// Create mock ERC20 contract for testing
const MockERC20 = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
`;

// Write mock ERC20 contract
require('fs').writeFileSync(
  './contracts/mocks/MockERC20.sol',
  MockERC20
);