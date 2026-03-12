const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MultiTokenTreasury - Relayer Functions", function () {
  let treasury;
  let mockUSDC;
  let owner, relayer, recipient, unauthorized, user1;
  let ethKeys, usdcKeys;

  const ETH_ADDRESS = ethers.constants.AddressZero;
  const ETH_DENOMINATION = ethers.utils.parseEther("0.1");
  const USDC_DENOMINATION = ethers.utils.parseUnits("100", 6);
  const UNPAIRED_LEAF_DOMAIN = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

  // ===== Custom index-based merkle tree matching Solidity MerkleVerifier =====

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

  // ===== Key generation =====

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

  // ===== Signing helpers =====

  async function getChainId() {
    return (await ethers.provider.getNetwork()).chainId;
  }

  async function signDirectWithdrawal(privateKey, recipientAddr, token, amount, merkleRootId, keyIndex) {
    const wallet = new ethers.Wallet(privateKey);
    const chainId = await getChainId();
    const encoded = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "uint256", "uint256", "uint256", "uint256"],
      [recipientAddr, token, amount, merkleRootId, keyIndex, chainId]
    );
    const messageHash = ethers.utils.keccak256(encoded);
    return wallet.signMessage(ethers.utils.arrayify(messageHash));
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

  // ===== Setup =====

  beforeEach(async function () {
    [owner, relayer, recipient, unauthorized, user1] = await ethers.getSigners();

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUSDC = await MockERC20.deploy("Mock USDC", "USDC", 6);
    await mockUSDC.deployed();

    // Deploy treasury
    const Treasury = await ethers.getContractFactory("MultiTokenTreasury");
    treasury = await Treasury.deploy(owner.address);
    await treasury.deployed();

    // Generate key sets with custom merkle trees
    const ethKeySet = generateKeySet(10);
    const ethTree = buildMerkleTree(ethKeySet.pubKeys);
    ethKeys = { ...ethKeySet, tree: ethTree };

    const usdcKeySet = generateKeySet(10);
    const usdcTree = buildMerkleTree(usdcKeySet.pubKeys);
    usdcKeys = { ...usdcKeySet, tree: usdcTree };

    // Add USDC support
    await treasury.addToken(mockUSDC.address, "USDC", 6, [USDC_DENOMINATION]);

    // Add merkle roots - ID 0 for ETH, ID 1 for USDC
    await treasury.addMerkleRoot(ethKeys.tree.root, ETH_ADDRESS, ETH_DENOMINATION, 10);
    await treasury.addMerkleRoot(usdcKeys.tree.root, mockUSDC.address, USDC_DENOMINATION, 10);

    // Fund treasury with ETH via deposit (M-2 fix: bare ETH transfers now rejected)
    await treasury.deposit(ETH_ADDRESS, ethers.utils.parseEther("10"), { value: ethers.utils.parseEther("10") });

    // Fund treasury with USDC
    await mockUSDC.mint(treasury.address, ethers.utils.parseUnits("10000", 6));

    // Authorize relayer
    await treasury.authorizeRelayer(relayer.address, true);

    // Set protocol fee to 0.5% (50 basis points)
    await treasury.setProtocolFee(50);

    // Set max gas price cap to 100 gwei
    await treasury.setMaxGasPriceCap(ethers.utils.parseUnits("100", "gwei"));

    // Fund relayer gas pool for ERC20 relay gas reimbursement
    await treasury.fundRelayerGasPool({ value: ethers.utils.parseEther("1") });
  });

  // =========== Admin Functions ===========

  describe("Relayer Admin Functions", function () {
    it("Should set protocol fee", async function () {
      await expect(treasury.setProtocolFee(100))
        .to.emit(treasury, "ProtocolFeeUpdated")
        .withArgs(50, 100);
      expect(await treasury.protocolFeeBasisPoints()).to.equal(100);
    });

    it("Should reject protocol fee > 5%", async function () {
      await expect(treasury.setProtocolFee(501)).to.be.revertedWith("Fee too high");
    });

    it("Should set max gas price cap", async function () {
      const newCap = ethers.utils.parseUnits("200", "gwei");
      await expect(treasury.setMaxGasPriceCap(newCap))
        .to.emit(treasury, "MaxGasPriceCapUpdated");
      expect(await treasury.maxGasPriceCap()).to.equal(newCap);
    });

    it("Should authorize and revoke relayers", async function () {
      const newRelayer = unauthorized.address;
      await expect(treasury.authorizeRelayer(newRelayer, true))
        .to.emit(treasury, "RelayerAuthorized")
        .withArgs(newRelayer, true);
      expect(await treasury.authorizedRelayers(newRelayer)).to.be.true;

      await treasury.authorizeRelayer(newRelayer, false);
      expect(await treasury.authorizedRelayers(newRelayer)).to.be.false;
    });

    it("Should only allow owner to set relayer config", async function () {
      await expect(
        treasury.connect(user1).setProtocolFee(100)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        treasury.connect(user1).authorizeRelayer(user1.address, true)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  // =========== Merkle Root Optimization ===========

  describe("Merkle Root Management", function () {
    it("Should look up merkle root by hash in O(1)", async function () {
      const [found, rootId] = await treasury.getMerkleRootIdByHash(ethKeys.tree.root);
      expect(found).to.be.true;
      expect(rootId).to.equal(0);

      const [found2, rootId2] = await treasury.getMerkleRootIdByHash(usdcKeys.tree.root);
      expect(found2).to.be.true;
      expect(rootId2).to.equal(1);
    });

    it("Should return false for non-existent root hash", async function () {
      const fakeRoot = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("fake"));
      const [found, rootId] = await treasury.getMerkleRootIdByHash(fakeRoot);
      expect(found).to.be.false;
      expect(rootId).to.equal(0);
    });

    it("Should deactivate merkle root", async function () {
      await expect(treasury.deactivateMerkleRoot(0))
        .to.emit(treasury, "MerkleRootDeactivated")
        .withArgs(0);

      const [found] = await treasury.getMerkleRootIdByHash(ethKeys.tree.root);
      expect(found).to.be.false;
    });

    it("Should reject withdrawal from deactivated merkle root", async function () {
      await treasury.deactivateMerkleRoot(0);

      const keyIndex = 0;
      const maxRelayerFee = ethers.utils.parseEther("0.01");
      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      await expect(
        treasury.connect(relayer).withdrawViaRelayer(
          ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
          0, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.reverted;
    });

    it("Should prevent duplicate merkle root hashes", async function () {
      await expect(
        treasury.addMerkleRoot(ethKeys.tree.root, ETH_ADDRESS, ETH_DENOMINATION, 10)
      ).to.be.revertedWith("Merkle root already exists");
    });
  });

  // =========== Pause/Unpause ===========

  describe("Pause and Unpause", function () {
    it("Should pause and block withdrawals", async function () {
      await treasury.pause();

      const keyIndex = 0;
      const maxRelayerFee = ethers.utils.parseEther("0.01");
      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      await expect(
        treasury.connect(relayer).withdrawViaRelayer(
          ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
          0, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.revertedWith("Pausable: paused");
    });

    it("Should unpause and allow withdrawals again", async function () {
      await treasury.pause();
      await treasury.unpause();

      const keyIndex = 0;
      const maxRelayerFee = ethers.utils.parseEther("0.01");
      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "RelayedWithdrawal");
      expect(event).to.not.be.undefined;
    });

    it("Should block direct deposits when paused", async function () {
      await treasury.pause();
      await expect(
        treasury.deposit(ETH_ADDRESS, ETH_DENOMINATION, { value: ETH_DENOMINATION })
      ).to.be.revertedWith("Pausable: paused");
    });

    it("Should only allow owner to pause/unpause", async function () {
      await expect(
        treasury.connect(user1).pause()
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  // =========== withdrawViaRelayer - ETH ===========

  describe("withdrawViaRelayer - ETH", function () {
    it("Should relay ETH withdrawal successfully", async function () {
      const keyIndex = 0;
      const maxRelayerFee = ethers.utils.parseEther("0.01");

      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      const recipientBalBefore = await recipient.getBalance();

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const recipientBalAfter = await recipient.getBalance();
      expect(recipientBalAfter.sub(recipientBalBefore)).to.be.gt(0);

      const event = receipt.events.find(e => e.event === "RelayedWithdrawal");
      expect(event).to.not.be.undefined;
      expect(event.args.token).to.equal(ETH_ADDRESS);
      expect(event.args.recipient).to.equal(recipient.address);
      expect(event.args.relayer).to.equal(relayer.address);
      expect(event.args.protocolFee).to.be.gt(0);
      expect(event.args.gasReimbursement).to.be.gt(0);

      // netAmount + protocolFee + gasReimbursement should equal denomination
      const total = event.args.netAmount.add(event.args.protocolFee).add(event.args.gasReimbursement);
      expect(total).to.equal(ETH_DENOMINATION);
    });

    it("Should reject unauthorized relayer", async function () {
      const keyIndex = 1;
      const maxRelayerFee = ethers.utils.parseEther("0.01");

      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, unauthorized.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      await expect(
        treasury.connect(unauthorized).withdrawViaRelayer(
          ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
          0, signature, proof, keyIndex,
          unauthorized.address, maxRelayerFee
        )
      ).to.be.reverted;
    });

    it("Should prevent double-spending via relayer", async function () {
      const keyIndex = 2;
      const maxRelayerFee = ethers.utils.parseEther("0.01");

      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      await treasury.connect(relayer).withdrawViaRelayer(
        ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );

      await expect(
        treasury.connect(relayer).withdrawViaRelayer(
          ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
          0, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.reverted;
    });

    it("Should reject if maxRelayerFee is too low (ETH)", async function () {
      const keyIndex = 3;
      const maxRelayerFee = ethers.BigNumber.from(1); // 1 wei - way too low

      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      await expect(
        treasury.connect(relayer).withdrawViaRelayer(
          ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
          0, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.reverted;
    });

    it("Should still work with original withdraw() (backward compatibility)", async function () {
      const keyIndex = 4;
      const signature = await signDirectWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS, ETH_DENOMINATION, 0, keyIndex
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      const recipientBalBefore = await recipient.getBalance();

      await treasury.connect(user1).withdraw(
        ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
        0, signature, proof, keyIndex
      );

      const recipientBalAfter = await recipient.getBalance();
      expect(recipientBalAfter.sub(recipientBalBefore)).to.be.gt(0);
    });
  });

  // =========== withdrawViaRelayer - ERC20 ===========

  describe("withdrawViaRelayer - ERC20", function () {
    it("Should relay ERC20 withdrawal with gas reimbursement in ETH", async function () {
      const keyIndex = 0;
      // maxRelayerFee for ERC20 is in token units (covers protocol fee only)
      const maxRelayerFee = ethers.utils.parseUnits("10", 6); // 10 USDC cap

      const signature = await signRelayedWithdrawal(
        usdcKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 1, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(usdcKeys.tree, keyIndex);

      const recipientUsdcBefore = await mockUSDC.balanceOf(recipient.address);
      const relayerEthBefore = await relayer.getBalance();

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        1, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const recipientUsdcAfter = await mockUSDC.balanceOf(recipient.address);
      const usdcReceived = recipientUsdcAfter.sub(recipientUsdcBefore);
      expect(usdcReceived).to.be.gt(0);
      expect(usdcReceived).to.be.lt(USDC_DENOMINATION);

      const event = receipt.events.find(e => e.event === "RelayedWithdrawal");
      expect(event).to.not.be.undefined;
      expect(event.args.protocolFee).to.be.gt(0);
      expect(event.args.gasReimbursement).to.be.gt(0);

      // Protocol fee (USDC) should be 0.5% of 100 USDC = 0.5 USDC = 500000
      expect(event.args.protocolFee).to.equal(ethers.utils.parseUnits("0.5", 6));

      // Recipient gets amount minus protocol fee
      expect(usdcReceived).to.equal(USDC_DENOMINATION.sub(event.args.protocolFee));
    });

    it("Should reject ERC20 relay if protocol fee exceeds maxRelayerFee", async function () {
      // Set protocol fee to 5% = 500 bps → 5 USDC on 100 USDC withdrawal
      await treasury.setProtocolFee(500);

      const keyIndex = 1;
      // maxRelayerFee = 1 USDC which is less than the 5 USDC protocol fee
      const maxRelayerFee = ethers.utils.parseUnits("1", 6);

      const signature = await signRelayedWithdrawal(
        usdcKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 1, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(usdcKeys.tree, keyIndex);

      await expect(
        treasury.connect(relayer).withdrawViaRelayer(
          mockUSDC.address, recipient.address, USDC_DENOMINATION,
          1, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.reverted;
    });
  });

  // =========== withdrawToAddress (swap) ===========

  describe("withdrawToAddress - Swap", function () {
    it("Should withdraw ETH to swap target address", async function () {
      const keyIndex = 5;
      const swapTarget = ethers.Wallet.createRandom().address;
      const maxRelayerFee = ethers.utils.parseEther("0.01");

      const signature = await signSwapWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, swapTarget, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      const targetBalBefore = await ethers.provider.getBalance(swapTarget);

      const tx = await treasury.connect(relayer).withdrawToAddress(
        ETH_ADDRESS, swapTarget, recipient.address, ETH_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const targetBalAfter = await ethers.provider.getBalance(swapTarget);
      expect(targetBalAfter.sub(targetBalBefore)).to.be.gt(0);

      const event = receipt.events.find(e => e.event === "RelayedSwapWithdrawal");
      expect(event).to.not.be.undefined;
      expect(event.args.targetAddress).to.equal(swapTarget);
    });

    it("Should withdraw ERC20 to swap target address", async function () {
      const keyIndex = 1;
      const swapTarget = ethers.Wallet.createRandom().address;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signSwapWithdrawal(
        usdcKeys.privKeys[keyIndex], recipient.address, swapTarget, mockUSDC.address,
        USDC_DENOMINATION, 1, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(usdcKeys.tree, keyIndex);

      const targetUsdcBefore = await mockUSDC.balanceOf(swapTarget);

      await treasury.connect(relayer).withdrawToAddress(
        mockUSDC.address, swapTarget, recipient.address, USDC_DENOMINATION,
        1, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );

      const targetUsdcAfter = await mockUSDC.balanceOf(swapTarget);
      expect(targetUsdcAfter.sub(targetUsdcBefore)).to.be.gt(0);
    });

    it("Should reject zero target address", async function () {
      const keyIndex = 6;
      const maxRelayerFee = ethers.utils.parseEther("0.01");

      const signature = await signSwapWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      await expect(
        treasury.connect(relayer).withdrawToAddress(
          ETH_ADDRESS, ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
          0, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.reverted;
    });

    it("Should prevent using same key for both relay and swap withdrawal", async function () {
      const keyIndex = 7;
      const swapTarget = ethers.Wallet.createRandom().address;
      const maxRelayerFee = ethers.utils.parseEther("0.01");

      // First: use key for relayed withdrawal
      const sig1 = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      await treasury.connect(relayer).withdrawViaRelayer(
        ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
        0, sig1, proof, keyIndex,
        relayer.address, maxRelayerFee
      );

      // Second: try to use same key for swap → should fail (nullifier used)
      const sig2 = await signSwapWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, swapTarget, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );

      await expect(
        treasury.connect(relayer).withdrawToAddress(
          ETH_ADDRESS, swapTarget, recipient.address, ETH_DENOMINATION,
          0, sig2, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.reverted;
    });
  });

  // =========== Fee Accounting (Security Fix S1/S4) ===========

  describe("Fee Accounting", function () {
    it("Should use cumulative fee tracking (not reset on withdrawal)", async function () {
      // Do two relayed ETH withdrawals to accumulate fees
      for (let i = 0; i < 2; i++) {
        const maxRelayerFee = ethers.utils.parseEther("0.01");
        const signature = await signRelayedWithdrawal(
          ethKeys.privKeys[i], recipient.address, ETH_ADDRESS,
          ETH_DENOMINATION, 0, i, relayer.address, maxRelayerFee
        );
        const proof = getProof(ethKeys.tree, i);
        await treasury.connect(relayer).withdrawViaRelayer(
          ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
          0, signature, proof, i,
          relayer.address, maxRelayerFee
        );
      }

      // Check cumulative fees
      const stats1 = await treasury.getTokenStats(ETH_ADDRESS);
      const feesBeforeWithdraw = stats1.fees;
      expect(feesBeforeWithdraw).to.be.gt(0);

      // Withdraw fees
      await treasury.withdrawFees(ETH_ADDRESS);

      // Verify totalFeesCollected is NOT reset — still equals cumulative total
      const stats2 = await treasury.getTokenStats(ETH_ADDRESS);
      expect(stats2.fees).to.equal(feesBeforeWithdraw); // NOT reset to 0

      // Verify totalFeesWithdrawn tracks what was taken
      const feesWithdrawn = await treasury.totalFeesWithdrawn(ETH_ADDRESS);
      expect(feesWithdrawn).to.equal(feesBeforeWithdraw);

      // Second withdrawFees should revert (no new fees)
      await expect(treasury.withdrawFees(ETH_ADDRESS)).to.be.revertedWith("No fees to withdraw");
    });

    it("Should allow withdrawing fees after more accumulate", async function () {
      // First relay + fee withdrawal
      const keyIndex = 0;
      const maxRelayerFee = ethers.utils.parseEther("0.01");
      const sig1 = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof1 = getProof(ethKeys.tree, keyIndex);
      await treasury.connect(relayer).withdrawViaRelayer(
        ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
        0, sig1, proof1, keyIndex,
        relayer.address, maxRelayerFee
      );
      await treasury.withdrawFees(ETH_ADDRESS);

      // Second relay generates more fees
      const keyIndex2 = 1;
      const sig2 = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex2], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex2, relayer.address, maxRelayerFee
      );
      const proof2 = getProof(ethKeys.tree, keyIndex2);
      await treasury.connect(relayer).withdrawViaRelayer(
        ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
        0, sig2, proof2, keyIndex2,
        relayer.address, maxRelayerFee
      );

      // Should be able to withdraw again (only new fees)
      await expect(treasury.withdrawFees(ETH_ADDRESS))
        .to.emit(treasury, "FeesWithdrawn");
    });
  });

  // =========== Denomination O(1) Lookup (Security Fix S2) ===========

  describe("Denomination Lookup", function () {
    it("Should validate denominations via O(1) mapping", async function () {
      expect(await treasury.denominationExists(ETH_ADDRESS, ETH_DENOMINATION)).to.be.true;
      expect(await treasury.denominationExists(ETH_ADDRESS, ethers.utils.parseEther("999"))).to.be.false;
      expect(await treasury.denominationExists(mockUSDC.address, USDC_DENOMINATION)).to.be.true;
    });

    it("Should update denominationExists when adding new denominations", async function () {
      const newDenom = ethers.utils.parseUnits("500", 6);
      expect(await treasury.denominationExists(mockUSDC.address, newDenom)).to.be.false;

      await treasury.updateDenominations(mockUSDC.address, [newDenom]);

      expect(await treasury.denominationExists(mockUSDC.address, newDenom)).to.be.true;
      // Old denomination still exists
      expect(await treasury.denominationExists(mockUSDC.address, USDC_DENOMINATION)).to.be.true;
    });
  });

  // =========== Active Roots Counter (Security Fix S3) ===========

  describe("Active Roots Counter", function () {
    it("Should track active roots count correctly", async function () {
      // Already have 2 roots from setup (ETH + USDC)
      expect(await treasury.activeRootsCount()).to.equal(2);
    });

    it("Should decrement on deactivation", async function () {
      await treasury.deactivateMerkleRoot(0);
      expect(await treasury.activeRootsCount()).to.equal(1);
    });

    it("Should increment when adding new roots", async function () {
      const newKeys = generateKeySet(4);
      const newTree = buildMerkleTree(newKeys.pubKeys);
      await treasury.addMerkleRoot(newTree.root, ETH_ADDRESS, ETH_DENOMINATION, 4);
      expect(await treasury.activeRootsCount()).to.equal(3);
    });

    it("Should reject double-deactivation", async function () {
      await treasury.deactivateMerkleRoot(0);
      await expect(treasury.deactivateMerkleRoot(0)).to.be.revertedWith("Already deactivated");
    });
  });

  // =========== Relayer Mismatch (Security Fix S2) ===========

  describe("Relayer Mismatch Protection", function () {
    it("Should reject if relayer param does not match msg.sender", async function () {
      const keyIndex = 9;
      const maxRelayerFee = ethers.utils.parseEther("0.01");

      // Sign with relayer.address as the relayer
      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      // But call from unauthorized account passing relayer.address as param
      // → msg.sender (unauthorized) != relayer.address → should revert
      await expect(
        treasury.connect(unauthorized).withdrawViaRelayer(
          ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
          0, signature, proof, keyIndex,
          relayer.address, maxRelayerFee
        )
      ).to.be.revertedWith("Relayer mismatch");
    });
  });

  // =========== Gas Reimbursement Accuracy ===========

  describe("Gas Reimbursement", function () {
    it("Should reimburse reasonable gas cost for ETH relay", async function () {
      const keyIndex = 8;
      const maxRelayerFee = ethers.utils.parseEther("0.05");

      const signature = await signRelayedWithdrawal(
        ethKeys.privKeys[keyIndex], recipient.address, ETH_ADDRESS,
        ETH_DENOMINATION, 0, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(ethKeys.tree, keyIndex);

      const relayerBalBefore = await relayer.getBalance();

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        ETH_ADDRESS, recipient.address, ETH_DENOMINATION,
        0, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();

      const event = receipt.events.find(e => e.event === "RelayedWithdrawal");
      const gasReimbursed = event.args.gasReimbursement;
      const actualGasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice);

      console.log(`  Actual gas cost: ${ethers.utils.formatEther(actualGasCost)} ETH`);
      console.log(`  Gas reimbursed:  ${ethers.utils.formatEther(gasReimbursed)} ETH`);
      console.log(`  Protocol fee:    ${ethers.utils.formatEther(event.args.protocolFee)} ETH`);
      console.log(`  Net to recipient: ${ethers.utils.formatEther(event.args.netAmount)} ETH`);

      expect(gasReimbursed).to.be.gt(0);

      // Reimbursement uses a fixed 55000 gas overhead estimate for transfers + events.
      // On hardhat the total TX gas is higher than the overhead alone, so the ratio
      // will be less than 100%. The key invariant: reimbursement > 0 and < denomination.
      const ratio = gasReimbursed.mul(100).div(actualGasCost);
      console.log(`  Reimbursement ratio: ${ratio.toString()}%`);
      expect(ratio).to.be.gte(20); // At least 20% of actual cost (fixed overhead is conservative)
      expect(ratio).to.be.lte(300); // At most 300% of actual cost
    });

    it("Should reimburse relayer gas in ETH for ERC20 relay", async function () {
      const keyIndex = 2;
      const maxRelayerFee = ethers.utils.parseUnits("10", 6);

      const signature = await signRelayedWithdrawal(
        usdcKeys.privKeys[keyIndex], recipient.address, mockUSDC.address,
        USDC_DENOMINATION, 1, keyIndex, relayer.address, maxRelayerFee
      );
      const proof = getProof(usdcKeys.tree, keyIndex);

      const relayerEthBefore = await relayer.getBalance();
      const relayerUsdcBefore = await mockUSDC.balanceOf(relayer.address);

      const tx = await treasury.connect(relayer).withdrawViaRelayer(
        mockUSDC.address, recipient.address, USDC_DENOMINATION,
        1, signature, proof, keyIndex,
        relayer.address, maxRelayerFee
      );
      const receipt = await tx.wait();
      const gasCostPaid = receipt.gasUsed.mul(receipt.effectiveGasPrice);

      const relayerEthAfter = await relayer.getBalance();
      const relayerUsdcAfter = await mockUSDC.balanceOf(relayer.address);

      const event = receipt.events.find(e => e.event === "RelayedWithdrawal");

      // H-1 fix: Protocol fee is now retained in contract, NOT sent to relayer
      const usdcGained = relayerUsdcAfter.sub(relayerUsdcBefore);
      expect(usdcGained).to.equal(0); // Relayer gets no USDC, only gas reimbursement in ETH

      // Relayer should have received ETH gas reimbursement (minus TX gas they paid)
      // Net ETH = gasReimbursement - gasCostPaid
      const ethGained = relayerEthAfter.sub(relayerEthBefore);
      const netReimbursement = ethGained.add(gasCostPaid); // what they received from contract
      expect(netReimbursement).to.be.gt(0);

      console.log(`  ERC20 relay: Protocol fee ${ethers.utils.formatUnits(usdcGained, 6)} USDC`);
      console.log(`  ERC20 relay: Gas reimbursement ${ethers.utils.formatEther(event.args.gasReimbursement)} ETH`);
      console.log(`  ERC20 relay: Actual gas cost ${ethers.utils.formatEther(gasCostPaid)} ETH`);
    });
  });
});
