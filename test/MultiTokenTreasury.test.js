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

  // ============================================================
  // NEW FEATURE TESTS: ERC20 Token-Based Gas Deduction, Admin
  //   Functions, getRelayFeeEstimate, and Edge Cases
  // ============================================================

  // Helper: ensure block.basefee is non-zero for gas calculation tests
  const setBaseFee = async (gweiHex = "0x3B9ACA00") => { // 1 gwei
    await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", [gweiHex]);
  };

  describe("ERC20 Token-Based Gas Deduction (ethPricePerToken > 0)", function () {
    let relayer;
    let relayKeys, relayTree;

    const UNPAIRED_LEAF_DOMAIN = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
    const USDC_DENOMINATION = ethers.utils.parseUnits("100", 6);

    function hashLeaf(address) {
      return ethers.utils.keccak256(
        ethers.utils.solidityPack(["address"], [address])
      );
    }

    function hashPair(left, right) {
      return ethers.utils.keccak256(
        ethers.utils.solidityPack(["bytes32", "bytes32"], [left, right])
      );
    }

    function buildMerkleTree(addresses) {
      const leaves = addresses.map(addr => hashLeaf(addr));
      let currentLevel = [...leaves];
      const levels = [currentLevel];

      while (currentLevel.length > 1) {
        const nextLevel = [];
        for (let i = 0; i < Math.ceil(currentLevel.length / 2); i++) {
          const leftIndex = i * 2;
          const rightIndex = leftIndex + 1;
          if (rightIndex < currentLevel.length) {
            nextLevel.push(hashPair(currentLevel[leftIndex], currentLevel[rightIndex]));
          } else {
            nextLevel.push(hashPair(currentLevel[leftIndex], UNPAIRED_LEAF_DOMAIN));
          }
        }
        currentLevel = nextLevel;
        levels.push(currentLevel);
      }

      return { root: currentLevel[0], levels, leaves };
    }

    function getProof(tree, index) {
      const proof = [];
      let currentIndex = index;

      for (let level = 0; level < tree.levels.length - 1; level++) {
        const currentLevel = tree.levels[level];
        if (currentIndex % 2 === 0) {
          if (currentIndex + 1 < currentLevel.length) {
            proof.push(currentLevel[currentIndex + 1]);
          } else {
            proof.push(UNPAIRED_LEAF_DOMAIN);
          }
        } else {
          proof.push(currentLevel[currentIndex - 1]);
        }
        currentIndex = Math.floor(currentIndex / 2);
      }

      return proof;
    }

    function generateKeySet(count) {
      const privKeys = [];
      const pubKeys = [];
      for (let i = 0; i < count; i++) {
        const wallet = ethers.Wallet.createRandom();
        privKeys.push(wallet.privateKey);
        pubKeys.push(wallet.address);
      }
      return { privKeys, pubKeys };
    }

    async function getChainId() {
      return (await ethers.provider.getNetwork()).chainId;
    }

    async function signRelayedWithdrawal(privateKey, recipientAddr, token, amount, merkleRootId, keyIndex, relayerAddr, maxRelayerFee) {
      const wallet = new ethers.Wallet(privateKey);
      const chainId = await getChainId();
      const encoded = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint256", "uint256", "uint256", "uint256", "address", "uint256"],
        [recipientAddr, token, amount, merkleRootId, keyIndex, chainId, relayerAddr, maxRelayerFee]
      );
      const messageHash = ethers.utils.keccak256(encoded);
      return wallet.signMessage(ethers.utils.arrayify(messageHash));
    }

    async function signSwapWithdrawal(privateKey, recipientAddr, targetAddr, token, amount, merkleRootId, keyIndex, relayerAddr, maxRelayerFee) {
      const wallet = new ethers.Wallet(privateKey);
      const chainId = await getChainId();
      const encoded = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "address", "uint256", "uint256", "uint256", "uint256", "address", "uint256"],
        [recipientAddr, targetAddr, token, amount, merkleRootId, keyIndex, chainId, relayerAddr, maxRelayerFee]
      );
      const messageHash = ethers.utils.keccak256(encoded);
      return wallet.signMessage(ethers.utils.arrayify(messageHash));
    }

    beforeEach(async function () {
      [owner, user1, user2, recipient, relayer] = await ethers.getSigners();

      // Deploy mock tokens
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      mockUSDT = await MockERC20.deploy("Mock USDT", "USDT", 6);
      mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);

      // Deploy treasury
      const Treasury = await ethers.getContractFactory("MultiTokenTreasury");
      treasury = await Treasury.deploy(owner.address);
      await treasury.deployed();

      // Add USDC support
      await treasury.addToken(mockUSDC.address, "USDC", 6, [USDC_DENOMINATION]);

      // Generate relay key set
      const keySet = generateKeySet(10);
      relayTree = buildMerkleTree(keySet.pubKeys);
      relayKeys = { ...keySet, tree: relayTree };

      // Add merkle root for USDC (ID 0)
      await treasury.addMerkleRoot(relayTree.root, mockUSDC.address, USDC_DENOMINATION, 10);

      // Fund treasury with USDC
      await mockUSDC.mint(treasury.address, ethers.utils.parseUnits("10000", 6));

      // Authorize relayer
      await treasury.authorizeRelayer(relayer.address, true);

      // Set protocol fee to 0.5% (50 basis points)
      await treasury.setProtocolFee(50);

      // Set max gas price cap to 100 gwei
      await treasury.setMaxGasPriceCap(ethers.utils.parseUnits("100", "gwei"));

      // Set ETH price per USDC: ETH = $2500, so 1 ETH = 2500 * 10^6 USDC units
      // ethPricePerToken[USDC] = 2500_000000
      await treasury.setEthPricePerToken(mockUSDC.address, ethers.utils.parseUnits("2500", 6));

    });

    beforeEach(async () => {
      // Ensure block.basefee stays at 1 gwei for gas calculation tests
      await setBaseFee();
    });

    it("Should deduct gas reimbursement in tokens from user's amount", async function () {
      const keyIndex = 0;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6); // 10 USDC cap

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      const recipientUsdcBefore = await mockUSDC.balanceOf(recipient.address);
      const relayerUsdcBefore = await mockUSDC.balanceOf(relayer.address);

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const recipientUsdcAfter = await mockUSDC.balanceOf(recipient.address);
      const relayerUsdcAfter = await mockUSDC.balanceOf(relayer.address);

      const usdcReceived = recipientUsdcAfter.sub(recipientUsdcBefore);
      const relayerUsdcReceived = relayerUsdcAfter.sub(relayerUsdcBefore);

      // With token-based gas deduction, recipient gets less than amount - protocolFee
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000); // 0.5 USDC
      expect(usdcReceived).to.be.lt(USDC_DENOMINATION.sub(protocolFee));

      // Relayer should receive gas reimbursement in USDC tokens
      expect(relayerUsdcReceived).to.be.gt(0);

      // Total out = recipientAmount + protocolFee + gasReimbursementInTokens = denomination
      const totalOut = usdcReceived.add(protocolFee).add(relayerUsdcReceived);
      expect(totalOut).to.equal(USDC_DENOMINATION);
    });

    it("Should send gas reimbursement tokens to relayer", async function () {
      const keyIndex = 1;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      const relayerUsdcBefore = await mockUSDC.balanceOf(relayer.address);

      await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );

      const relayerUsdcAfter = await mockUSDC.balanceOf(relayer.address);
      const relayerTokenGain = relayerUsdcAfter.sub(relayerUsdcBefore);

      // Relayer should have received USDC tokens as gas reimbursement
      expect(relayerTokenGain).to.be.gt(0);

      // Relayer should NOT have received ETH reimbursement from gas pool (token-based path)
      // We can verify gas pool was not touched
      const gasPoolAfter = await treasury.relayerGasPool();
      expect(gasPoolAfter).to.equal(0); // No gas pool was funded
    });

    it("Should correctly calculate protocol fee + gas reimbursement breakdown", async function () {
      const keyIndex = 2;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      const recipientBefore = await mockUSDC.balanceOf(recipient.address);
      const relayerBefore = await mockUSDC.balanceOf(relayer.address);

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const recipientAfter = await mockUSDC.balanceOf(recipient.address);
      const relayerAfter = await mockUSDC.balanceOf(relayer.address);

      const netToRecipient = recipientAfter.sub(recipientBefore);
      const gasTokensToRelayer = relayerAfter.sub(relayerBefore);
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000); // 0.5 USDC = 500000

      // Verify: netAmount + protocolFee + gasReimbursementInTokens == denomination
      expect(netToRecipient.add(protocolFee).add(gasTokensToRelayer)).to.equal(USDC_DENOMINATION);

      // Protocol fee should be exactly 0.5 USDC
      expect(protocolFee).to.equal(ethers.utils.parseUnits("0.5", 6));

      // Gas tokens should be: erc20RelayFixedGas * tx.gasprice * ethPricePerToken / 1e18
      // On hardhat, gasprice is typically low, but should be > 0
      expect(gasTokensToRelayer).to.be.gt(0);

      console.log(`  Protocol fee: ${ethers.utils.formatUnits(protocolFee, 6)} USDC`);
      console.log(`  Gas reimbursement (tokens): ${ethers.utils.formatUnits(gasTokensToRelayer, 6)} USDC`);
      console.log(`  Net to recipient: ${ethers.utils.formatUnits(netToRecipient, 6)} USDC`);
    });

    it("Should revert if protocolFee + gasReimbursementInTokens > maxRelayerFee", async function () {
      const keyIndex = 3;
      // Set a very low maxRelayerFee that covers protocol fee but not gas reimbursement
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000); // 0.5 USDC
      const maxRelayerFee = protocolFee; // Exactly protocol fee, no room for gas tokens

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      // Gas reimbursement in tokens > 0, so total fee > maxRelayerFee → should revert
      await expect(
        treasury.connect(relayer).withdrawViaRelayer(
          mockUSDC.address, recipient.address, USDC_DENOMINATION,
          0, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.reverted; // MaxRelayerFeeExceeded
    });

    it("Should net amount to recipient be correct (amount - protocolFee - gasTokens)", async function () {
      const keyIndex = 4;
      const maxRelayerFee = ethers.utils.parseUnits("50", 6); // generous cap

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      const recipientBefore = await mockUSDC.balanceOf(recipient.address);

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "RelayedWithdrawal");

      const recipientAfter = await mockUSDC.balanceOf(recipient.address);
      const netReceived = recipientAfter.sub(recipientBefore);

      // Event netAmount should match what recipient actually received
      expect(netReceived).to.equal(event.args.netAmount);

      // Net should be less than denomination
      expect(netReceived).to.be.lt(USDC_DENOMINATION);
      expect(netReceived).to.be.gt(0);
    });
  });

  describe("Fallback to Gas Pool (ethPricePerToken == 0)", function () {
    let relayer;
    let relayKeys, relayTree;

    const UNPAIRED_LEAF_DOMAIN = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
    const USDC_DENOMINATION = ethers.utils.parseUnits("100", 6);

    function hashLeaf(address) {
      return ethers.utils.keccak256(
        ethers.utils.solidityPack(["address"], [address])
      );
    }

    function hashPair(left, right) {
      return ethers.utils.keccak256(
        ethers.utils.solidityPack(["bytes32", "bytes32"], [left, right])
      );
    }

    function buildMerkleTree(addresses) {
      const leaves = addresses.map(addr => hashLeaf(addr));
      let currentLevel = [...leaves];
      const levels = [currentLevel];

      while (currentLevel.length > 1) {
        const nextLevel = [];
        for (let i = 0; i < Math.ceil(currentLevel.length / 2); i++) {
          const leftIndex = i * 2;
          const rightIndex = leftIndex + 1;
          if (rightIndex < currentLevel.length) {
            nextLevel.push(hashPair(currentLevel[leftIndex], currentLevel[rightIndex]));
          } else {
            nextLevel.push(hashPair(currentLevel[leftIndex], UNPAIRED_LEAF_DOMAIN));
          }
        }
        currentLevel = nextLevel;
        levels.push(currentLevel);
      }

      return { root: currentLevel[0], levels, leaves };
    }

    function getProof(tree, index) {
      const proof = [];
      let currentIndex = index;

      for (let level = 0; level < tree.levels.length - 1; level++) {
        const currentLevel = tree.levels[level];
        if (currentIndex % 2 === 0) {
          if (currentIndex + 1 < currentLevel.length) {
            proof.push(currentLevel[currentIndex + 1]);
          } else {
            proof.push(UNPAIRED_LEAF_DOMAIN);
          }
        } else {
          proof.push(currentLevel[currentIndex - 1]);
        }
        currentIndex = Math.floor(currentIndex / 2);
      }

      return proof;
    }

    function generateKeySet(count) {
      const privKeys = [];
      const pubKeys = [];
      for (let i = 0; i < count; i++) {
        const wallet = ethers.Wallet.createRandom();
        privKeys.push(wallet.privateKey);
        pubKeys.push(wallet.address);
      }
      return { privKeys, pubKeys };
    }

    async function getChainId() {
      return (await ethers.provider.getNetwork()).chainId;
    }

    async function signRelayedWithdrawal(privateKey, recipientAddr, token, amount, merkleRootId, keyIndex, relayerAddr, maxRelayerFee) {
      const wallet = new ethers.Wallet(privateKey);
      const chainId = await getChainId();
      const encoded = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint256", "uint256", "uint256", "uint256", "address", "uint256"],
        [recipientAddr, token, amount, merkleRootId, keyIndex, chainId, relayerAddr, maxRelayerFee]
      );
      const messageHash = ethers.utils.keccak256(encoded);
      return wallet.signMessage(ethers.utils.arrayify(messageHash));
    }

    beforeEach(async function () {
      [owner, user1, user2, recipient, relayer] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiTokenTreasury");
      treasury = await Treasury.deploy(owner.address);
      await treasury.deployed();

      await treasury.addToken(mockUSDC.address, "USDC", 6, [USDC_DENOMINATION]);

      const keySet = generateKeySet(10);
      relayTree = buildMerkleTree(keySet.pubKeys);
      relayKeys = { ...keySet, tree: relayTree };

      await treasury.addMerkleRoot(relayTree.root, mockUSDC.address, USDC_DENOMINATION, 10);
      await mockUSDC.mint(treasury.address, ethers.utils.parseUnits("10000", 6));

      await treasury.authorizeRelayer(relayer.address, true);
      await treasury.setProtocolFee(50);
      await treasury.setMaxGasPriceCap(ethers.utils.parseUnits("100", "gwei"));

      // Fund relayer gas pool (for gas-pool fallback)
      await treasury.fundRelayerGasPool({ value: ethers.utils.parseEther("1") });

      // Do NOT set ethPricePerToken — defaults to 0
    });

    it("Should use relayerGasPool for ETH reimbursement when ethPricePerToken is 0", async function () {
      const keyIndex = 0;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      const gasPoolBefore = await treasury.relayerGasPool();
      const relayerEthBefore = await relayer.getBalance();
      const relayerUsdcBefore = await mockUSDC.balanceOf(relayer.address);

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const gasPoolAfter = await treasury.relayerGasPool();
      const relayerUsdcAfter = await mockUSDC.balanceOf(relayer.address);

      // Gas pool should have decreased (ETH used for reimbursement)
      expect(gasPoolAfter).to.be.lt(gasPoolBefore);

      // Relayer should NOT receive USDC tokens (no token-based gas deduction)
      expect(relayerUsdcAfter.sub(relayerUsdcBefore)).to.equal(0);

      // Recipient should receive amount minus protocol fee only (no token gas deduction)
      const recipientUsdc = await mockUSDC.balanceOf(recipient.address);
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000);
      expect(recipientUsdc).to.equal(USDC_DENOMINATION.sub(protocolFee));
    });

    it("Should revert ERC20 relay if gas pool is empty and ethPricePerToken is 0", async function () {
      // Withdraw all from gas pool
      await treasury.withdrawRelayerGasPool(ethers.utils.parseEther("1"));

      const keyIndex = 1;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      // Should revert with InsufficientGasPool since gas pool is empty
      await expect(
        treasury.connect(relayer).withdrawViaRelayer(
          mockUSDC.address, recipient.address, USDC_DENOMINATION,
          0, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.reverted; // InsufficientGasPool
    });
  });

  describe("Admin Functions - New ERC20 Gas Features", function () {
    beforeEach(async function () {
      [owner, user1, user2, recipient] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      mockUSDT = await MockERC20.deploy("Mock USDT", "USDT", 6);
      mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiTokenTreasury");
      treasury = await Treasury.deploy(owner.address);
      await treasury.deployed();
    });

    describe("setEthPricePerToken", function () {
      it("Should set ETH price per token and emit event", async function () {
        const price = ethers.utils.parseUnits("2500", 6); // 2500 USDC per ETH

        await expect(treasury.setEthPricePerToken(mockUSDC.address, price))
          .to.emit(treasury, "EthPricePerTokenUpdated")
;

        expect(await treasury.ethPricePerToken(mockUSDC.address)).to.equal(price);
      });

      it("Should update existing price and emit event with old/new values", async function () {
        const price1 = ethers.utils.parseUnits("2500", 6);
        const price2 = ethers.utils.parseUnits("3000", 6);

        await treasury.setEthPricePerToken(mockUSDC.address, price1);

        await expect(treasury.setEthPricePerToken(mockUSDC.address, price2))
          .to.emit(treasury, "EthPricePerTokenUpdated")
;

        expect(await treasury.ethPricePerToken(mockUSDC.address)).to.equal(price2);
      });

      it("Should allow setting price to 0 (disables token-based gas deduction)", async function () {
        const price = ethers.utils.parseUnits("2500", 6);
        await treasury.setEthPricePerToken(mockUSDC.address, price);

        await expect(treasury.setEthPricePerToken(mockUSDC.address, 0))
          .to.emit(treasury, "EthPricePerTokenUpdated")
;

        expect(await treasury.ethPricePerToken(mockUSDC.address)).to.equal(0);
      });

      it("Should only allow owner to set ETH price per token", async function () {
        await expect(
          treasury.connect(user1).setEthPricePerToken(mockUSDC.address, 1000)
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("setEthPricePerTokenBatch", function () {
      it("Should batch set prices for multiple tokens", async function () {
        const usdcPrice = ethers.utils.parseUnits("2500", 6);
        const usdtPrice = ethers.utils.parseUnits("2500", 6);

        const tx = await treasury.setEthPricePerTokenBatch(
          [mockUSDC.address, mockUSDT.address],
          [usdcPrice, usdtPrice]
        );
        const receipt = await tx.wait();

        expect(await treasury.ethPricePerToken(mockUSDC.address)).to.equal(usdcPrice);
        expect(await treasury.ethPricePerToken(mockUSDT.address)).to.equal(usdtPrice);

        // Should emit two EthPricePerTokenUpdated events
        const events = receipt.events.filter(e => e.event === "EthPricePerTokenUpdated");
        expect(events.length).to.equal(2);
      });

      it("Should revert on length mismatch", async function () {
        await expect(
          treasury.setEthPricePerTokenBatch(
            [mockUSDC.address, mockUSDT.address],
            [ethers.utils.parseUnits("2500", 6)] // Only one price for two tokens
          )
        ).to.be.revertedWith("Length mismatch");
      });

      it("Should only allow owner to batch set prices", async function () {
        await expect(
          treasury.connect(user1).setEthPricePerTokenBatch(
            [mockUSDC.address],
            [ethers.utils.parseUnits("2500", 6)]
          )
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });

      it("Should handle empty arrays", async function () {
        // Empty arrays should succeed (no-op)
        await expect(
          treasury.setEthPricePerTokenBatch([], [])
        ).to.not.be.reverted;
      });
    });

    describe("setERC20RelayFixedGas", function () {
      it("Should set fixed gas and emit event", async function () {
        await expect(treasury.setERC20RelayFixedGas(300000))
          .to.emit(treasury, "ERC20RelayFixedGasUpdated")
          .withArgs(200000, 300000); // Default is 200000

        expect(await treasury.erc20RelayFixedGas()).to.equal(300000);
      });

      it("Should reject fixed gas > 500000", async function () {
        await expect(
          treasury.setERC20RelayFixedGas(500001)
        ).to.be.revertedWith("Fixed gas too high");
      });

      it("Should accept exactly 500000", async function () {
        await expect(treasury.setERC20RelayFixedGas(500000)).to.not.be.reverted;
        expect(await treasury.erc20RelayFixedGas()).to.equal(500000);
      });

      it("Should accept 0 (effectively disabling fixed gas cost)", async function () {
        await expect(treasury.setERC20RelayFixedGas(0)).to.not.be.reverted;
        expect(await treasury.erc20RelayFixedGas()).to.equal(0);
      });

      it("Should only allow owner to set fixed gas", async function () {
        await expect(
          treasury.connect(user1).setERC20RelayFixedGas(300000)
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("getRelayFeeEstimate View Function", function () {
    beforeEach(async function () {
      [owner, user1] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiTokenTreasury");
      treasury = await Treasury.deploy(owner.address);
      await treasury.deployed();

      await treasury.addToken(mockUSDC.address, "USDC", 6, [ethers.utils.parseUnits("100", 6)]);
      await treasury.setProtocolFee(50); // 0.5%
    });

    it("Should return correct breakdown for native ETH", async function () {
      const amount = ethers.utils.parseEther("0.1");
      const gasPrice = ethers.utils.parseUnits("10", "gwei");

      const result = await treasury.getRelayFeeEstimate(
        ethers.constants.AddressZero, amount, gasPrice
      );

      // Protocol fee = 0.1 ETH * 50 / 10000 = 0.0005 ETH
      const expectedProtocolFee = amount.mul(50).div(10000);
      expect(result.protocolFee).to.equal(expectedProtocolFee);

      // Gas reimbursement ETH = 250000 * gasPrice
      const expectedGasEth = ethers.BigNumber.from(250000).mul(gasPrice);
      expect(result.gasReimbursementEth).to.equal(expectedGasEth);

      // Gas reimbursement in tokens should be 0 for native ETH
      expect(result.gasReimbursementToken).to.equal(0);

      // Net amount = amount - protocolFee - gasReimbursementEth
      const expectedNet = amount.sub(expectedProtocolFee).sub(expectedGasEth);
      expect(result.netAmount).to.equal(expectedNet);

      // Fee basis points
      expect(result.feeBps).to.equal(50);

      // Token price should be 0 for ETH
      expect(result.tokenPrice).to.equal(0);
    });

    it("Should return correct breakdown for ERC20 with price set", async function () {
      const ethPrice = ethers.utils.parseUnits("2500", 6); // 2500 USDC per ETH
      await treasury.setEthPricePerToken(mockUSDC.address, ethPrice);

      const amount = ethers.utils.parseUnits("100", 6); // 100 USDC
      const gasPrice = ethers.utils.parseUnits("10", "gwei");

      const result = await treasury.getRelayFeeEstimate(
        mockUSDC.address, amount, gasPrice
      );

      // Protocol fee = 100 * 50 / 10000 = 0.5 USDC = 500000
      expect(result.protocolFee).to.equal(ethers.utils.parseUnits("0.5", 6));

      // Gas reimbursement in tokens = fixedGas * gasPrice * ethPrice / 1e18
      // = 200000 * 10e9 * 2500e6 / 1e18 = 200000 * 10e9 * 2500e6 / 1e18
      const fixedGas = await treasury.erc20RelayFixedGas();
      const gasCostWei = fixedGas.mul(gasPrice);
      const expectedGasTokens = gasCostWei.mul(ethPrice).div(ethers.utils.parseEther("1"));
      expect(result.gasReimbursementToken).to.equal(expectedGasTokens);

      // Gas reimbursement ETH should be 0 for ERC20 with price set
      expect(result.gasReimbursementEth).to.equal(0);

      // Net = amount - protocolFee - gasReimbursementToken
      const expectedNet = amount.sub(result.protocolFee).sub(expectedGasTokens);
      expect(result.netAmount).to.equal(expectedNet);

      // Token price returned
      expect(result.tokenPrice).to.equal(ethPrice);

      // Fixed gas returned
      expect(result.fixedGas).to.equal(200000);
    });

    it("Should return correct breakdown for ERC20 without price set (gas from pool)", async function () {
      // Do NOT set ethPricePerToken — defaults to 0

      const amount = ethers.utils.parseUnits("100", 6);
      const gasPrice = ethers.utils.parseUnits("10", "gwei");

      const result = await treasury.getRelayFeeEstimate(
        mockUSDC.address, amount, gasPrice
      );

      // Protocol fee = 0.5 USDC
      expect(result.protocolFee).to.equal(ethers.utils.parseUnits("0.5", 6));

      // No gas reimbursement in tokens or ETH for ERC20 without price
      expect(result.gasReimbursementToken).to.equal(0);
      expect(result.gasReimbursementEth).to.equal(0);

      // Net = amount - protocolFee only
      expect(result.netAmount).to.equal(amount.sub(result.protocolFee));

      // Token price should be 0
      expect(result.tokenPrice).to.equal(0);
    });

    it("Should handle zero gas price", async function () {
      const ethPrice = ethers.utils.parseUnits("2500", 6);
      await treasury.setEthPricePerToken(mockUSDC.address, ethPrice);

      const amount = ethers.utils.parseUnits("100", 6);

      const result = await treasury.getRelayFeeEstimate(
        mockUSDC.address, amount, 0 // zero gas price
      );

      // Gas reimbursement should be 0 with zero gas price
      expect(result.gasReimbursementToken).to.equal(0);

      // Net = amount - protocolFee
      expect(result.netAmount).to.equal(amount.sub(result.protocolFee));
    });

    it("Should handle zero protocol fee", async function () {
      await treasury.setProtocolFee(0);

      const amount = ethers.utils.parseEther("0.1");
      const gasPrice = ethers.utils.parseUnits("10", "gwei");

      const result = await treasury.getRelayFeeEstimate(
        ethers.constants.AddressZero, amount, gasPrice
      );

      expect(result.protocolFee).to.equal(0);
      expect(result.feeBps).to.equal(0);

      const expectedGasEth = ethers.BigNumber.from(250000).mul(gasPrice);
      expect(result.netAmount).to.equal(amount.sub(expectedGasEth));
    });
  });

  describe("Edge Cases - Token-Based Gas Deduction", function () {
    let relayer;
    let relayKeys, relayTree;
    let mockDAI;

    const UNPAIRED_LEAF_DOMAIN = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

    beforeEach(async () => { await setBaseFee(); });
    const USDC_DENOMINATION = ethers.utils.parseUnits("100", 6);

    function hashLeaf(address) {
      return ethers.utils.keccak256(
        ethers.utils.solidityPack(["address"], [address])
      );
    }

    function hashPair(left, right) {
      return ethers.utils.keccak256(
        ethers.utils.solidityPack(["bytes32", "bytes32"], [left, right])
      );
    }

    function buildMerkleTree(addresses) {
      const leaves = addresses.map(addr => hashLeaf(addr));
      let currentLevel = [...leaves];
      const levels = [currentLevel];

      while (currentLevel.length > 1) {
        const nextLevel = [];
        for (let i = 0; i < Math.ceil(currentLevel.length / 2); i++) {
          const leftIndex = i * 2;
          const rightIndex = leftIndex + 1;
          if (rightIndex < currentLevel.length) {
            nextLevel.push(hashPair(currentLevel[leftIndex], currentLevel[rightIndex]));
          } else {
            nextLevel.push(hashPair(currentLevel[leftIndex], UNPAIRED_LEAF_DOMAIN));
          }
        }
        currentLevel = nextLevel;
        levels.push(currentLevel);
      }

      return { root: currentLevel[0], levels, leaves };
    }

    function getProof(tree, index) {
      const proof = [];
      let currentIndex = index;

      for (let level = 0; level < tree.levels.length - 1; level++) {
        const currentLevel = tree.levels[level];
        if (currentIndex % 2 === 0) {
          if (currentIndex + 1 < currentLevel.length) {
            proof.push(currentLevel[currentIndex + 1]);
          } else {
            proof.push(UNPAIRED_LEAF_DOMAIN);
          }
        } else {
          proof.push(currentLevel[currentIndex - 1]);
        }
        currentIndex = Math.floor(currentIndex / 2);
      }

      return proof;
    }

    function generateKeySet(count) {
      const privKeys = [];
      const pubKeys = [];
      for (let i = 0; i < count; i++) {
        const wallet = ethers.Wallet.createRandom();
        privKeys.push(wallet.privateKey);
        pubKeys.push(wallet.address);
      }
      return { privKeys, pubKeys };
    }

    async function getChainId() {
      return (await ethers.provider.getNetwork()).chainId;
    }

    async function signRelayedWithdrawal(privateKey, recipientAddr, token, amount, merkleRootId, keyIndex, relayerAddr, maxRelayerFee) {
      const wallet = new ethers.Wallet(privateKey);
      const chainId = await getChainId();
      const encoded = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "uint256", "uint256", "uint256", "uint256", "address", "uint256"],
        [recipientAddr, token, amount, merkleRootId, keyIndex, chainId, relayerAddr, maxRelayerFee]
      );
      const messageHash = ethers.utils.keccak256(encoded);
      return wallet.signMessage(ethers.utils.arrayify(messageHash));
    }

    async function signSwapWithdrawal(privateKey, recipientAddr, targetAddr, token, amount, merkleRootId, keyIndex, relayerAddr, maxRelayerFee) {
      const wallet = new ethers.Wallet(privateKey);
      const chainId = await getChainId();
      const encoded = ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "address", "uint256", "uint256", "uint256", "uint256", "address", "uint256"],
        [recipientAddr, targetAddr, token, amount, merkleRootId, keyIndex, chainId, relayerAddr, maxRelayerFee]
      );
      const messageHash = ethers.utils.keccak256(encoded);
      return wallet.signMessage(ethers.utils.arrayify(messageHash));
    }

    beforeEach(async function () {
      [owner, user1, user2, recipient, relayer] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);
      // Deploy a mock DAI with 18 decimals
      mockDAI = await MockERC20.deploy("Mock DAI", "DAI", 18);

      const Treasury = await ethers.getContractFactory("MultiTokenTreasury");
      treasury = await Treasury.deploy(owner.address);
      await treasury.deployed();

      await treasury.addToken(mockUSDC.address, "USDC", 6, [USDC_DENOMINATION]);

      const keySet = generateKeySet(10);
      relayTree = buildMerkleTree(keySet.pubKeys);
      relayKeys = { ...keySet, tree: relayTree };

      await treasury.addMerkleRoot(relayTree.root, mockUSDC.address, USDC_DENOMINATION, 10);
      await mockUSDC.mint(treasury.address, ethers.utils.parseUnits("100000", 6));

      await treasury.authorizeRelayer(relayer.address, true);
      await treasury.setProtocolFee(50);
      await treasury.setMaxGasPriceCap(ethers.utils.parseUnits("500", "gwei"));
    });

    it("Should handle very high ETH price per token without overflow", async function () {
      // Set extremely high price: 1 ETH = 100,000 USDC (100000 * 10^6)
      const highPrice = ethers.utils.parseUnits("100000", 6);
      await treasury.setEthPricePerToken(mockUSDC.address, highPrice);

      const keyIndex = 0;
      // Need high maxRelayerFee to accommodate the large gas tokens
      const maxRelayerFee = ethers.utils.parseUnits("99", 6); // 99 USDC

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      // On hardhat, gas price is very low (~1 gwei), so even with high exchange
      // rate, gas tokens should be manageable
      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "RelayedWithdrawal");
      expect(event).to.not.be.undefined;

      // Verify math is consistent
      const relayerUsdc = await mockUSDC.balanceOf(relayer.address);
      const recipientUsdc = await mockUSDC.balanceOf(recipient.address);
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000);
      expect(recipientUsdc.add(protocolFee).add(relayerUsdc)).to.equal(USDC_DENOMINATION);
    });

    it("Should handle token with very low exchange rate (1 ETH = 1 token unit)", async function () {
      // Very low rate: 1 ETH = 1 USDC unit (0.000001 USDC)
      await treasury.setEthPricePerToken(mockUSDC.address, 1);

      const keyIndex = 1;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const relayerUsdc = await mockUSDC.balanceOf(relayer.address);
      // With very low rate, gas reimbursement in tokens may round to 0
      // (200000 * ~1gwei * 1 / 1e18 = ~0.0002 → rounds to 0 for 6-decimal token)
      // That's fine — relayer gets 0 tokens, recipient gets amount - protocolFee
      const recipientUsdc = await mockUSDC.balanceOf(recipient.address);
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000);
      expect(recipientUsdc.add(protocolFee).add(relayerUsdc)).to.equal(USDC_DENOMINATION);

      console.log(`  Very low rate — gas tokens to relayer: ${relayerUsdc.toString()}`);
    });

    it("Should handle withdrawToAddress with token-based gas deduction", async function () {
      await treasury.setEthPricePerToken(mockUSDC.address, ethers.utils.parseUnits("2500", 6));

      const keyIndex = 2;
      const swapTarget = ethers.Wallet.createRandom().address;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signSwapWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, swapTarget, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      const relayerUsdcBefore = await mockUSDC.balanceOf(relayer.address);

      const tx = await treasury.connect(relayer).withdrawToAddress(
        mockUSDC.address, swapTarget, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const event = receipt.events.find(e => e.event === "RelayedSwapWithdrawal");
      expect(event).to.not.be.undefined;

      // Tokens sent to swap target, not recipient
      const targetUsdc = await mockUSDC.balanceOf(swapTarget);
      expect(targetUsdc).to.be.gt(0);

      // Relayer should get gas reimbursement in tokens
      const relayerUsdcAfter = await mockUSDC.balanceOf(relayer.address);
      const relayerTokenGain = relayerUsdcAfter.sub(relayerUsdcBefore);
      expect(relayerTokenGain).to.be.gt(0);

      // Total: target + protocolFee + relayerTokens = denomination
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000);
      expect(targetUsdc.add(protocolFee).add(relayerTokenGain)).to.equal(USDC_DENOMINATION);
    });

    it("Should handle withdrawToAddress fallback to gas pool when ethPricePerToken is 0", async function () {
      // Do NOT set ethPricePerToken
      // Fund gas pool instead
      await treasury.fundRelayerGasPool({ value: ethers.utils.parseEther("1") });

      const keyIndex = 3;
      const swapTarget = ethers.Wallet.createRandom().address;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signSwapWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, swapTarget, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      const gasPoolBefore = await treasury.relayerGasPool();

      await treasury.connect(relayer).withdrawToAddress(
        mockUSDC.address, swapTarget, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );

      const gasPoolAfter = await treasury.relayerGasPool();

      // Gas pool should decrease (ETH sent to relayer)
      expect(gasPoolAfter).to.be.lt(gasPoolBefore);

      // Target receives amount minus protocol fee (no token gas deduction)
      const targetUsdc = await mockUSDC.balanceOf(swapTarget);
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000);
      expect(targetUsdc).to.equal(USDC_DENOMINATION.sub(protocolFee));

      // Relayer gets 0 USDC (gas reimbursed in ETH from pool)
      expect(await mockUSDC.balanceOf(relayer.address)).to.equal(0);
    });

    it("Should handle erc20RelayFixedGas set to 0 (zero gas token deduction)", async function () {
      await treasury.setEthPricePerToken(mockUSDC.address, ethers.utils.parseUnits("2500", 6));
      await treasury.setERC20RelayFixedGas(0);

      const keyIndex = 4;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signRelayedWithdrawal(
        relayKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(relayKeys.tree, keyIndex);

      await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );

      // With fixedGas=0, gasReimbursementInTokens = 0 * gasprice * price / 1e18 = 0
      // Relayer gets 0 tokens
      expect(await mockUSDC.balanceOf(relayer.address)).to.equal(0);

      // Recipient gets amount - protocolFee
      const protocolFee = USDC_DENOMINATION.mul(50).div(10000);
      expect(await mockUSDC.balanceOf(recipient.address)).to.equal(USDC_DENOMINATION.sub(protocolFee));
    });

    it("Should correctly estimate fees via getRelayFeeEstimate for large values", async function () {
      // Test with large amount and high gas price to verify no overflow
      const largeAmount = ethers.utils.parseUnits("1000000", 6); // 1M USDC
      const highGasPrice = ethers.utils.parseUnits("500", "gwei");
      const highEthPrice = ethers.utils.parseUnits("10000", 6); // 10000 USDC per ETH

      // USDC already added in beforeEach — just set the price
      await treasury.setEthPricePerToken(mockUSDC.address, highEthPrice);

      const result = await treasury.getRelayFeeEstimate(
        mockUSDC.address, largeAmount, highGasPrice
      );

      // Protocol fee = 1M * 50 / 10000 = 5000 USDC
      expect(result.protocolFee).to.equal(ethers.utils.parseUnits("5000", 6));

      // Gas tokens = 200000 * 500gwei * 10000e6 / 1e18
      //            = 200000 * 500e9 * 10000e6 / 1e18
      //            = 1e14 * 1e10 / 1e18 = 1e6 = 1 USDC
      const expectedGasTokens = ethers.BigNumber.from(200000)
        .mul(highGasPrice)
        .mul(highEthPrice)
        .div(ethers.utils.parseEther("1"));
      expect(result.gasReimbursementToken).to.equal(expectedGasTokens);

      // Net = 1M - 5000 - gasTokens
      expect(result.netAmount).to.equal(largeAmount.sub(result.protocolFee).sub(expectedGasTokens));

      console.log(`  Large value test — protocol fee: ${ethers.utils.formatUnits(result.protocolFee, 6)} USDC`);
      console.log(`  Gas tokens: ${ethers.utils.formatUnits(result.gasReimbursementToken, 6)} USDC`);
      console.log(`  Net: ${ethers.utils.formatUnits(result.netAmount, 6)} USDC`);
    });

    it("Should return netAmount=0 when fees exceed amount in getRelayFeeEstimate", async function () {
      // Set very high gas price and exchange rate so fees exceed amount
      const veryHighEthPrice = ethers.utils.parseUnits("1000000", 6); // 1M USDC per ETH
      await treasury.setEthPricePerToken(mockUSDC.address, veryHighEthPrice);
      await treasury.setERC20RelayFixedGas(500000); // Max fixed gas

      const amount = ethers.utils.parseUnits("100", 6);
      const highGasPrice = ethers.utils.parseUnits("500", "gwei");

      const result = await treasury.getRelayFeeEstimate(
        mockUSDC.address, amount, highGasPrice
      );

      // Gas tokens = 500000 * 500gwei * 1M_USDC / 1e18 = very large
      // Should exceed 100 USDC, so netAmount should be 0 (clamped, not underflow)
      expect(result.netAmount).to.equal(0);
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