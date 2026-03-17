// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./TokenHandler.sol";
import "./GetterHelpers.sol";
import "./MerkleVerifier.sol";

/**
 * @title MultiTokenTreasury
 * @notice Privacy-preserving multi-token treasury with ECDSA-OTS
 * @dev Supports ETH and multiple ERC20 tokens with different denominations
 */
contract MultiTokenTreasury is Ownable, ReentrancyGuard, Pausable {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;
    using TokenHandler for TokenHandler.TokenInfo;

    // Constants
    address constant ETH_ADDRESS = address(0);
    uint256 constant MAX_MERKLE_ROOTS = 1000;
    uint256 constant MIN_LIQUIDITY_RESERVE = 0; // No minimum liquidity for testnet

    // Token management
    mapping(address => TokenHandler.TokenInfo) public tokenInfo;
    address[] public supportedTokens;

    // Merkle root management - BIND TO TOKEN AND DENOMINATION
    struct MerkleRootInfo {
        bytes32 root;
        address token;          // Token this root is for
        uint256 denomination;   // Specific denomination
        uint256 timestamp;
        bool isActive;
        uint256 totalKeys;
        uint256 usedKeys;
    }

    MerkleRootInfo[] public merkleRoots;
    mapping(bytes32 => uint256) public merkleRootToId; // Stores rootId+1 (0 = not found). M-3 fix.
    mapping(bytes32 => bool) public merkleRootExists; // For O(1) duplicate detection

    // Nullifier tracking (prevents double-spending)
    mapping(bytes32 => bool) public nullifiers;

    // Denomination O(1) lookup (token => denomination => exists)
    mapping(address => mapping(uint256 => bool)) public denominationExists;

    // Active merkle roots counter (avoids counting loop in getActiveMerkleRoots)
    uint256 public activeRootsCount;

    // Statistics
    mapping(address => uint256) public totalDeposited;
    mapping(address => uint256) public totalWithdrawn;
    mapping(address => uint256) public totalFeesCollected;    // Cumulative fees collected (never reset)
    mapping(address => uint256) public totalFeesWithdrawn;    // Cumulative fees withdrawn by admin

    // Relayer configuration
    uint256 public protocolFeeBasisPoints;              // Admin-configurable protocol fee (e.g., 50 = 0.5%)
    uint256 public maxGasPriceCap;                      // Max reimbursable gas price in wei (anti-griefing)
    mapping(address => bool) public authorizedRelayers;  // Whitelisted relayer addresses
    uint256 public relayerGasPool;                       // Separate ETH pool for ERC20 relay gas reimbursement
    uint256 public relayGasOverhead = 50000;             // H-3 fix: Configurable gas overhead for relay reimbursement
    uint256 public erc20RelayFixedGas = 200000;          // Fixed gas estimate for ERC20 relay fee calculation
    mapping(address => uint256) public ethPricePerToken;  // How many token units (in smallest unit) equal 1 ETH — admin-set via CoinGecko

    // Events
    event TokenAdded(address indexed token, string symbol, uint8 decimals, uint256[] denominations);
    event TokenRemoved(address indexed token);
    event Deposit(address indexed token, address indexed depositor, uint256 amount, bytes32 commitment);
    event Withdrawal(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        bytes32 nullifierHash,
        uint256 fee,
        uint256 merkleRootId
    );
    event MerkleRootAdded(
        uint256 indexed rootId,
        bytes32 root,
        address indexed token,
        uint256 denomination,
        uint256 totalKeys
    );
    event MerkleRootDeactivated(uint256 indexed rootId);
    event FeesWithdrawn(address indexed token, uint256 amount);
    event RelayedWithdrawal(
        address indexed token,
        address indexed recipient,
        uint256 netAmount,
        bytes32 nullifierHash,
        uint256 protocolFee,
        uint256 gasReimbursement,
        address indexed relayer,
        uint256 merkleRootId
    );
    event RelayedSwapWithdrawal(
        address indexed token,
        address indexed targetAddress,
        uint256 netAmount,
        bytes32 nullifierHash,
        uint256 protocolFee,
        uint256 gasReimbursement,
        address indexed relayer,
        uint256 merkleRootId
    );
    event ProtocolFeeUpdated(uint256 oldFee, uint256 newFee);
    event MaxGasPriceCapUpdated(uint256 oldCap, uint256 newCap);
    event RelayerAuthorized(address indexed relayer, bool authorized);
    event EmergencyWithdrawal(address indexed token, uint256 amount);
    event RelayerGasPoolFunded(uint256 amount, uint256 newBalance);
    event RelayerGasPoolWithdrawn(uint256 amount, uint256 newBalance);
    event RelayGasOverheadUpdated(uint256 oldOverhead, uint256 newOverhead);
    event ERC20RelayFixedGasUpdated(uint256 oldGas, uint256 newGas);
    event EthPricePerTokenUpdated(address indexed token, uint256 oldPrice, uint256 newPrice);

    // Custom errors
    error TokenNotSupported();
    error InvalidDenomination(); // Amount below minimum denomination
    error InvalidMerkleRoot();
    error NullifierAlreadyUsed();
    error InvalidSignature();
    error InsufficientLiquidity();
    error MerkleRootNotFound();
    error InvalidTokenConfig();
    error UnauthorizedRelayer();
    error GasPriceExceedsCap();
    error MaxRelayerFeeExceeded();
    error GasReimbursementFailed();
    error InvalidSwapTarget();
    error InsufficientGasPool();
    error AllKeysUsed();

    constructor(address _owner) {
        _transferOwnership(_owner);

        // Determine native token symbol based on chain
        string memory nativeSymbol = "ETH";
        if (block.chainid == 56) {
            nativeSymbol = "BNB";
        } else if (block.chainid == 97) {
            nativeSymbol = "tBNB"; // Test BNB
        } else if (block.chainid == 137 || block.chainid == 80001 || block.chainid == 80002) {
            nativeSymbol = "POL";
        } else if (block.chainid == 43114 || block.chainid == 43113) {
            nativeSymbol = "AVAX";
        }

        // Add native token support by default
        uint256[] memory nativeDenominations = new uint256[](4);
        nativeDenominations[0] = 0.01 ether;
        nativeDenominations[1] = 0.1 ether;
        nativeDenominations[2] = 0.5 ether;
        nativeDenominations[3] = 1 ether;

        _addToken(ETH_ADDRESS, nativeSymbol, 18, nativeDenominations);

        // C-1 fix: Set a safe default gas price cap (500 gwei) to prevent relayer gas price manipulation
        maxGasPriceCap = 500 gwei;
    }

    // ============ Token Management ============

    /**
     * @notice Adds support for a new token
     * @param token Token address (address(0) for ETH)
     * @param symbol Token symbol for display
     * @param decimals Token decimals
     * @param denominations Supported withdrawal denominations in base units
     */
    function addToken(
        address token,
        string memory symbol,
        uint8 decimals,
        uint256[] memory denominations
    ) external onlyOwner {
        _addToken(token, symbol, decimals, denominations);
    }

    function _addToken(
        address token,
        string memory symbol,
        uint8 decimals,
        uint256[] memory denominations
    ) private {
        // L-3 fix: Block overwriting an active token (must removeToken first)
        require(!tokenInfo[token].isActive || token == ETH_ADDRESS && supportedTokens.length == 0,
            "Token already active; remove it first");

        if (!TokenHandler.validateDenominations(denominations)) {
            revert InvalidTokenConfig();
        }

        // Verify token decimals match for ERC20
        if (token != ETH_ADDRESS) {
            require(IERC20Metadata(token).decimals() == decimals, "Decimal mismatch");
        }

        tokenInfo[token] = TokenHandler.TokenInfo({
            symbol: symbol,
            decimals: decimals,
            isActive: true,
            denominations: denominations
        });

        // Populate O(1) denomination lookup
        for (uint256 i = 0; i < denominations.length; i++) {
            denominationExists[token][denominations[i]] = true;
        }

        // Add to supported tokens array if new
        bool exists = false;
        for (uint256 i = 0; i < supportedTokens.length; i++) {
            if (supportedTokens[i] == token) {
                exists = true;
                break;
            }
        }
        if (!exists) {
            supportedTokens.push(token);
        }

        emit TokenAdded(token, symbol, decimals, denominations);
    }

    /**
     * @notice Removes support for a token
     * @param token Token address to remove
     */
    function removeToken(address token) external onlyOwner {
        if (!tokenInfo[token].isActive) revert TokenNotSupported();

        // Clean up denomination mappings to prevent stale entries on re-add
        TokenHandler.TokenInfo storage info = tokenInfo[token];
        for (uint256 i = 0; i < info.denominations.length; i++) {
            denominationExists[token][info.denominations[i]] = false;
        }

        // M-1 fix: Deactivate all Merkle roots associated with this token
        for (uint256 i = 0; i < merkleRoots.length; i++) {
            if (merkleRoots[i].isActive && merkleRoots[i].token == token) {
                merkleRoots[i].isActive = false;
                activeRootsCount--;
                emit MerkleRootDeactivated(i);
            }
        }

        tokenInfo[token].isActive = false;
        emit TokenRemoved(token);
    }

    /**
     * @notice Updates denominations for an existing token by adding new ones
     * @dev Cannot remove existing denominations to preserve merkle root validity
     * @param token Token address
     * @param newDenominations Additional denominations to add
     */
    function updateDenominations(
        address token,
        uint256[] memory newDenominations
    ) external onlyOwner {
        if (!tokenInfo[token].isActive) revert TokenNotSupported();
        if (!TokenHandler.validateDenominations(newDenominations)) {
            revert InvalidTokenConfig();
        }

        TokenHandler.TokenInfo storage info = tokenInfo[token];

        // Use denominationExists mapping for O(1) duplicate detection
        for (uint256 i = 0; i < newDenominations.length; i++) {
            if (!denominationExists[token][newDenominations[i]]) {
                info.denominations.push(newDenominations[i]);
                denominationExists[token][newDenominations[i]] = true;
            }
        }

        emit TokenAdded(token, info.symbol, info.decimals, info.denominations);
    }

    // ============ Merkle Root Management ============

    /**
     * @notice Adds a new merkle root for key validation
     * @dev Uses O(1) mapping lookup for duplicate detection instead of array iteration
     * @param root Merkle root hash
     * @param token Token address this root is for
     * @param denomination Specific denomination for this root
     * @param totalKeys Total number of keys in this batch
     */
    function addMerkleRoot(
        bytes32 root,
        address token,
        uint256 denomination,
        uint256 totalKeys
    ) external onlyOwner {
        require(merkleRoots.length < MAX_MERKLE_ROOTS, "Too many merkle roots");

        // O(1) duplicate check via dedicated bool mapping
        require(!merkleRootExists[root], "Merkle root already exists");

        // Verify token and denomination are valid
        TokenHandler.TokenInfo storage info = tokenInfo[token];
        require(info.isActive, "Token not supported");
        require(
            TokenHandler.isValidDenomination(info, denomination),
            "Invalid denomination for token"
        );

        uint256 rootId = merkleRoots.length;
        merkleRoots.push(MerkleRootInfo({
            root: root,
            token: token,
            denomination: denomination,
            timestamp: block.timestamp,
            isActive: true,
            totalKeys: totalKeys,
            usedKeys: 0
        }));

        merkleRootToId[root] = rootId + 1; // M-3 fix: store id+1 so 0 means "not found"
        merkleRootExists[root] = true;
        activeRootsCount++;
        emit MerkleRootAdded(rootId, root, token, denomination, totalKeys);
    }

    /**
     * @notice Deactivates a merkle root
     * @param rootId ID of the merkle root to deactivate
     */
    function deactivateMerkleRoot(uint256 rootId) external onlyOwner {
        require(rootId < merkleRoots.length, "Invalid root ID");
        require(merkleRoots[rootId].isActive, "Already deactivated");
        merkleRoots[rootId].isActive = false;
        activeRootsCount--;
        emit MerkleRootDeactivated(rootId);
    }

    // ============ Core Functions ============

    /**
     * @notice Deposit tokens into the treasury
     * @param token Token address (address(0) for ETH)
     * @param amount Amount to deposit (any amount accepted; denomination matching is advisory)
     */
    function deposit(address token, uint256 amount) external payable whenNotPaused {
        TokenHandler.TokenInfo storage info = tokenInfo[token];
        if (!info.isActive) revert TokenNotSupported();
        if (amount == 0) revert InvalidDenomination();

        TokenHandler.handleDeposit(token, msg.sender, amount, msg.value);

        totalDeposited[token] += amount;

        // Generate commitment (hash of depositor + amount + timestamp)
        bytes32 commitment = keccak256(abi.encodePacked(
            msg.sender,
            token,
            amount,
            block.timestamp,
            blockhash(block.number - 1)
        ));

        emit Deposit(token, msg.sender, amount, commitment);
    }

    /**
     * @notice Withdraw tokens using ECDSA-OTS
     * @param token Token to withdraw
     * @param recipient Address to receive tokens
     * @param amount Amount to withdraw
     * @param merkleRootId ID of the merkle root
     * @param signature ECDSA signature from the one-time key
     * @param merkleProof Merkle proof for the key
     * @param keyIndex Index of the key in the merkle tree
     */
    function withdraw(
        address token,
        address payable recipient,
        uint256 amount,
        uint256 merkleRootId,
        bytes memory signature,
        bytes32[] calldata merkleProof,
        uint256 keyIndex
    ) external nonReentrant whenNotPaused {
        // Validate token and amount (O(1) via mapping)
        if (!tokenInfo[token].isActive) revert TokenNotSupported();
        if (!denominationExists[token][amount]) revert InvalidDenomination();

        // Validate merkle root
        if (merkleRootId >= merkleRoots.length) revert InvalidMerkleRoot();
        MerkleRootInfo storage rootInfo = merkleRoots[merkleRootId];
        if (!rootInfo.isActive) revert InvalidMerkleRoot();

        // Verify the merkle root is for the correct token and denomination
        require(rootInfo.token == token, "Merkle root token mismatch");
        require(rootInfo.denomination == amount, "Merkle root denomination mismatch");

        // Verify keys are not exhausted
        if (rootInfo.usedKeys >= rootInfo.totalKeys) revert AllKeysUsed();

        // Check liquidity (reserve relayer gas pool for ETH)
        uint256 balance = TokenHandler.getBalance(token);
        if (token == ETH_ADDRESS) {
            balance = balance > relayerGasPool ? balance - relayerGasPool : 0;
        }
        if (balance < amount) revert InsufficientLiquidity();

        // Create nullifier based on the key identity (merkleRootId + keyIndex)
        bytes32 nullifierHash = keccak256(abi.encodePacked(merkleRootId, keyIndex));
        if (nullifiers[nullifierHash]) revert NullifierAlreadyUsed();

        // Verify signature — binds to merkleRootId and keyIndex to prevent cross-root replay
        bytes32 messageHash = keccak256(abi.encode(
            recipient,
            token,
            amount,
            merkleRootId,
            keyIndex,
            block.chainid
        ));
        address signer = messageHash.toEthSignedMessageHash().recover(signature);

        // Verify merkle proof using index-based verification
        bytes32 leaf = keccak256(abi.encodePacked(signer));
        require(
            MerkleVerifier.verifyProof(rootInfo.root, leaf, merkleProof, keyIndex),
            "Invalid merkle proof"
        );

        // Mark nullifier as used
        nullifiers[nullifierHash] = true;
        rootInfo.usedKeys++;

        // Calculate fee using admin-configurable protocolFeeBasisPoints
        uint256 fee = (amount * protocolFeeBasisPoints) / 10000;
        uint256 netAmount = amount - fee;

        // Update statistics
        totalWithdrawn[token] += amount;
        totalFeesCollected[token] += fee;

        // Transfer tokens
        TokenHandler.handleWithdrawal(token, recipient, netAmount);

        emit Withdrawal(token, recipient, netAmount, nullifierHash, fee, merkleRootId);
    }

    // ============ Relayer Functions ============

    /**
     * @notice Sets the protocol fee (basis points)
     * @param _feeBps Fee in basis points (e.g., 50 = 0.5%, max 500 = 5%)
     */
    function setProtocolFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 500, "Fee too high");
        emit ProtocolFeeUpdated(protocolFeeBasisPoints, _feeBps);
        protocolFeeBasisPoints = _feeBps;
    }

    /**
     * @notice Sets the maximum gas price the contract will reimburse
     * @param _maxGasPriceCap Max gas price in wei (0 = no cap)
     */
    function setMaxGasPriceCap(uint256 _maxGasPriceCap) external onlyOwner {
        emit MaxGasPriceCapUpdated(maxGasPriceCap, _maxGasPriceCap);
        maxGasPriceCap = _maxGasPriceCap;
    }

    /**
     * @notice Authorizes or revokes a relayer address
     * @param _relayer Address to authorize/revoke
     * @param _authorized Whether the address is authorized
     */
    /**
     * @notice Sets the gas overhead estimate for relay reimbursement
     * @param _overhead Gas units for post-measurement operations (max 200000)
     */
    function setRelayGasOverhead(uint256 _overhead) external onlyOwner {
        require(_overhead <= 200000, "Overhead too high");
        emit RelayGasOverheadUpdated(relayGasOverhead, _overhead);
        relayGasOverhead = _overhead;
    }

    /**
     * @notice Sets the fixed gas estimate used for ERC20 relay fee calculation
     * @param _fixedGas Gas units (e.g. 200000). Max 500000.
     */
    function setERC20RelayFixedGas(uint256 _fixedGas) external onlyOwner {
        require(_fixedGas <= 500000, "Fixed gas too high");
        emit ERC20RelayFixedGasUpdated(erc20RelayFixedGas, _fixedGas);
        erc20RelayFixedGas = _fixedGas;
    }

    /**
     * @notice Sets the ETH-to-token exchange rate for ERC20 relay gas deduction
     * @dev Price is: how many token units (smallest denomination) equal 1 ETH.
     *      Example for USDC (6 decimals): if ETH = $2500, set to 2500_000000 (2500 * 10^6).
     *      Example for DAI (18 decimals): if ETH = $2500, set to 2500_000000000000000000 (2500 * 10^18).
     *      Set to 0 to disable token-based gas deduction and fall back to relayerGasPool.
     * @param token ERC20 token address
     * @param price Token units per 1 ETH
     */
    function setEthPricePerToken(address token, uint256 price) external onlyOwner {
        emit EthPricePerTokenUpdated(token, ethPricePerToken[token], price);
        ethPricePerToken[token] = price;
    }

    /**
     * @notice Batch-set ETH-to-token exchange rates
     * @param tokens Array of token addresses
     * @param prices Array of prices (token units per 1 ETH)
     */
    function setEthPricePerTokenBatch(address[] calldata tokens, uint256[] calldata prices) external onlyOwner {
        require(tokens.length == prices.length, "Length mismatch");
        for (uint256 i = 0; i < tokens.length; i++) {
            emit EthPricePerTokenUpdated(tokens[i], ethPricePerToken[tokens[i]], prices[i]);
            ethPricePerToken[tokens[i]] = prices[i];
        }
    }

    function authorizeRelayer(address _relayer, bool _authorized) external onlyOwner {
        authorizedRelayers[_relayer] = _authorized;
        emit RelayerAuthorized(_relayer, _authorized);
    }

    /**
     * @notice Fund the relayer gas pool (used for ERC20 relay gas reimbursement)
     * @dev Separates relay gas funds from user-deposited ETH
     */
    function fundRelayerGasPool() external payable onlyOwner {
        relayerGasPool += msg.value;
        emit RelayerGasPoolFunded(msg.value, relayerGasPool);
    }

    /**
     * @notice Withdraw from the relayer gas pool
     * @param amount Amount to withdraw
     */
    function withdrawRelayerGasPool(uint256 amount) external onlyOwner {
        require(relayerGasPool >= amount, "Insufficient gas pool");

        // C-2 fix: Solvency check — ensure remaining balance covers user deposits + fees
        uint256 ethUserDeposits = totalDeposited[ETH_ADDRESS] - totalWithdrawn[ETH_ADDRESS];
        uint256 ethFees = totalFeesCollected[ETH_ADDRESS] - totalFeesWithdrawn[ETH_ADDRESS];
        require(address(this).balance - amount >= ethUserDeposits + ethFees + (relayerGasPool - amount),
            "Would dip into user deposits or fees");

        relayerGasPool -= amount;
        (bool success, ) = owner().call{value: amount}("");
        require(success, "ETH transfer failed");
        emit RelayerGasPoolWithdrawn(amount, relayerGasPool);
    }

    /**
     * @notice Withdraw tokens via an authorized relayer (gas-free for user)
     * @dev Relayer pays gas and gets reimbursed from withdrawal amount.
     *      The OTS signature binds to the relayer address and maxRelayerFee.
     * @param token Token to withdraw
     * @param recipient Address to receive tokens
     * @param amount Denomination amount to withdraw
     * @param merkleRootId ID of the merkle root
     * @param signature ECDSA signature from the one-time key (covers relayer + maxRelayerFee)
     * @param merkleProof Merkle proof for the key
     * @param keyIndex Index of the key in the merkle tree
     * @param relayer Relayer address (must equal msg.sender)
     * @param maxRelayerFee Maximum total fee (protocol + gas) the user agreed to
     */
    function withdrawViaRelayer(
        address token,
        address payable recipient,
        uint256 amount,
        uint256 merkleRootId,
        bytes memory signature,
        bytes32[] calldata merkleProof,
        uint256 keyIndex,
        address relayer,
        uint256 maxRelayerFee
    ) external nonReentrant whenNotPaused {
        uint256 gasStart = gasleft();

        require(relayer == msg.sender, "Relayer mismatch");
        if (!authorizedRelayers[msg.sender]) revert UnauthorizedRelayer();
        if (maxGasPriceCap > 0 && tx.gasprice > maxGasPriceCap) revert GasPriceExceedsCap();

        // Shared validation + signature verification + fee calculation
        (bytes32 nullifierHash, uint256 protocolFee) = _validateRelayWithdrawal(
            token, recipient, amount, merkleRootId, signature, merkleProof, keyIndex,
            relayer, maxRelayerFee, address(0)
        );

        // Compute actual gas reimbursement from measured usage + overhead for remaining ops
        uint256 gasUsed = gasStart - gasleft() + relayGasOverhead;
        uint256 gasReimbursement = gasUsed * tx.gasprice;

        uint256 netAmount;

        if (token == ETH_ADDRESS) {
            // H-1 fix: ETH — protocol fee stays in contract, only gas reimbursement goes to relayer
            if (protocolFee + gasReimbursement > maxRelayerFee) revert MaxRelayerFeeExceeded();
            netAmount = amount - protocolFee - gasReimbursement;
            TokenHandler.handleWithdrawal(token, recipient, netAmount);
            // Only reimburse gas to relayer; protocol fee is retained for owner
            if (gasReimbursement > 0) {
                (bool success, ) = msg.sender.call{value: gasReimbursement}("");
                if (!success) revert GasReimbursementFailed();
            }
        } else {
            // ERC20 — protocol fee stays in contract
            // Gas reimbursement: deduct from token amount if exchange rate set, else from gas pool
            uint256 gasReimbursementInTokens = 0;
            uint256 tokenPrice = ethPricePerToken[token];

            if (tokenPrice > 0) {
                // Convert gas cost (ETH) to token units using admin-set exchange rate
                // Use fixed gas estimate instead of measured gas (more predictable for users)
                uint256 fixedGasCostWei = erc20RelayFixedGas * tx.gasprice;
                // gasReimbursementInTokens = fixedGasCostWei * tokenPrice / 1e18
                gasReimbursementInTokens = (fixedGasCostWei * tokenPrice) / 1e18;

                if (protocolFee + gasReimbursementInTokens > maxRelayerFee) revert MaxRelayerFeeExceeded();
                netAmount = amount - protocolFee - gasReimbursementInTokens;
                TokenHandler.handleWithdrawal(token, recipient, netAmount);
                // Send gas reimbursement tokens to relayer (they can swap to ETH off-chain)
                if (gasReimbursementInTokens > 0) {
                    SafeERC20.safeTransfer(IERC20(token), msg.sender, gasReimbursementInTokens);
                }
            } else {
                // Fallback: gas reimbursement from ETH gas pool (legacy behavior)
                if (protocolFee > maxRelayerFee) revert MaxRelayerFeeExceeded();
                netAmount = amount - protocolFee;
                TokenHandler.handleWithdrawal(token, recipient, netAmount);
                if (gasReimbursement > 0) {
                    if (relayerGasPool < gasReimbursement) revert InsufficientGasPool();
                    relayerGasPool -= gasReimbursement;
                    (bool success, ) = msg.sender.call{value: gasReimbursement}("");
                    if (!success) revert GasReimbursementFailed();
                }
            }
        }

        emit RelayedWithdrawal(token, recipient, netAmount, nullifierHash, protocolFee, gasReimbursement, msg.sender, merkleRootId);
    }

    /**
     * @notice Withdraw tokens to an arbitrary address via relayer (for swap-on-withdrawal)
     * @dev Tokens are sent to a target address (e.g., NEAR Intents deposit address)
     *      instead of the user's recipient address. Used for DEX swap integration.
     * @param token Token to withdraw
     * @param targetAddress Address to send tokens to (e.g., NEAR Intents deposit address)
     * @param recipient Original user address (included in signature for authorization proof)
     * @param amount Denomination amount to withdraw
     * @param merkleRootId ID of the merkle root
     * @param signature ECDSA signature from the one-time key
     * @param merkleProof Merkle proof for the key
     * @param keyIndex Index of the key in the merkle tree
     * @param relayer Relayer address (must equal msg.sender)
     * @param maxRelayerFee Maximum total fee the user agreed to
     */
    function withdrawToAddress(
        address token,
        address payable targetAddress,
        address recipient,
        uint256 amount,
        uint256 merkleRootId,
        bytes memory signature,
        bytes32[] calldata merkleProof,
        uint256 keyIndex,
        address relayer,
        uint256 maxRelayerFee
    ) external nonReentrant whenNotPaused {
        uint256 gasStart = gasleft();

        require(relayer == msg.sender, "Relayer mismatch");
        if (!authorizedRelayers[msg.sender]) revert UnauthorizedRelayer();
        if (maxGasPriceCap > 0 && tx.gasprice > maxGasPriceCap) revert GasPriceExceedsCap();
        if (targetAddress == address(0)) revert InvalidSwapTarget();

        // Shared validation + signature verification + fee calculation
        (bytes32 nullifierHash, uint256 protocolFee) = _validateRelayWithdrawal(
            token, recipient, amount, merkleRootId, signature, merkleProof, keyIndex,
            relayer, maxRelayerFee, targetAddress
        );

        // Compute actual gas reimbursement from measured usage + overhead
        uint256 gasUsed = gasStart - gasleft() + relayGasOverhead;
        uint256 gasReimbursement = gasUsed * tx.gasprice;

        uint256 netAmount;

        // Transfer to target address (e.g., NEAR Intents deposit address)
        // H-1 fix: protocol fee retained in contract, only gas reimbursement to relayer
        if (token == ETH_ADDRESS) {
            if (protocolFee + gasReimbursement > maxRelayerFee) revert MaxRelayerFeeExceeded();
            netAmount = amount - protocolFee - gasReimbursement;
            TokenHandler.handleWithdrawal(token, targetAddress, netAmount);
            if (gasReimbursement > 0) {
                (bool success, ) = msg.sender.call{value: gasReimbursement}("");
                if (!success) revert GasReimbursementFailed();
            }
        } else {
            // ERC20 — same token-based gas deduction logic as withdrawViaRelayer
            uint256 gasReimbursementInTokens = 0;
            uint256 tokenPrice = ethPricePerToken[token];

            if (tokenPrice > 0) {
                uint256 fixedGasCostWei = erc20RelayFixedGas * tx.gasprice;
                gasReimbursementInTokens = (fixedGasCostWei * tokenPrice) / 1e18;

                if (protocolFee + gasReimbursementInTokens > maxRelayerFee) revert MaxRelayerFeeExceeded();
                netAmount = amount - protocolFee - gasReimbursementInTokens;
                TokenHandler.handleWithdrawal(token, targetAddress, netAmount);
                if (gasReimbursementInTokens > 0) {
                    SafeERC20.safeTransfer(IERC20(token), msg.sender, gasReimbursementInTokens);
                }
            } else {
                if (protocolFee > maxRelayerFee) revert MaxRelayerFeeExceeded();
                netAmount = amount - protocolFee;
                TokenHandler.handleWithdrawal(token, targetAddress, netAmount);
                if (gasReimbursement > 0) {
                    if (relayerGasPool < gasReimbursement) revert InsufficientGasPool();
                    relayerGasPool -= gasReimbursement;
                    (bool success, ) = msg.sender.call{value: gasReimbursement}("");
                    if (!success) revert GasReimbursementFailed();
                }
            }
        }

        emit RelayedSwapWithdrawal(token, targetAddress, netAmount, nullifierHash, protocolFee, gasReimbursement, msg.sender, merkleRootId);
    }

    /**
     * @dev Shared validation logic for relayed withdrawals
     * @return nullifierHash The computed nullifier hash
     * @return protocolFee The calculated protocol fee
     * @return gasReimbursement The calculated gas reimbursement
     */
    /**
     * @dev Shared validation logic for relayed withdrawals.
     *      Gas reimbursement is computed by the caller using gasleft() tracking.
     * @return nullifierHash The computed nullifier hash
     * @return protocolFee The calculated protocol fee
     */
    function _validateRelayWithdrawal(
        address token,
        address recipient,
        uint256 amount,
        uint256 merkleRootId,
        bytes memory signature,
        bytes32[] calldata merkleProof,
        uint256 keyIndex,
        address relayer,
        uint256 maxRelayerFee,
        address targetAddress // address(0) for non-swap withdrawals
    ) private returns (bytes32 nullifierHash, uint256 protocolFee) {
        // Validate token and amount
        if (!tokenInfo[token].isActive) revert TokenNotSupported();
        if (!denominationExists[token][amount]) revert InvalidDenomination();

        // Validate merkle root
        if (merkleRootId >= merkleRoots.length) revert InvalidMerkleRoot();
        MerkleRootInfo storage rootInfo = merkleRoots[merkleRootId];
        if (!rootInfo.isActive) revert InvalidMerkleRoot();
        require(rootInfo.token == token, "Merkle root token mismatch");
        require(rootInfo.denomination == amount, "Merkle root denomination mismatch");

        // Verify keys are not exhausted
        if (rootInfo.usedKeys >= rootInfo.totalKeys) revert AllKeysUsed();

        // Check liquidity (reserve relayer gas pool for ETH)
        uint256 balance = TokenHandler.getBalance(token);
        if (token == ETH_ADDRESS) {
            balance = balance > relayerGasPool ? balance - relayerGasPool : 0;
        }
        if (balance < amount) revert InsufficientLiquidity();

        // Nullifier check
        nullifierHash = keccak256(abi.encodePacked(merkleRootId, keyIndex));
        if (nullifiers[nullifierHash]) revert NullifierAlreadyUsed();

        // Verify signature — binds to merkleRootId and keyIndex to prevent cross-root replay
        bytes32 messageHash;
        if (targetAddress == address(0)) {
            messageHash = keccak256(abi.encode(
                recipient, token, amount, merkleRootId, keyIndex,
                block.chainid, relayer, maxRelayerFee
            ));
        } else {
            messageHash = keccak256(abi.encode(
                recipient, targetAddress, token, amount, merkleRootId, keyIndex,
                block.chainid, relayer, maxRelayerFee
            ));
        }
        address signer = messageHash.toEthSignedMessageHash().recover(signature);

        // Verify merkle proof
        bytes32 leaf = keccak256(abi.encodePacked(signer));
        require(
            MerkleVerifier.verifyProof(rootInfo.root, leaf, merkleProof, keyIndex),
            "Invalid merkle proof"
        );

        // Mark nullifier as used
        nullifiers[nullifierHash] = true;
        rootInfo.usedKeys++;

        // Calculate protocol fee
        protocolFee = (amount * protocolFeeBasisPoints) / 10000;

        // Update statistics
        totalWithdrawn[token] += amount;
        totalFeesCollected[token] += protocolFee;

        return (nullifierHash, protocolFee);
    }

    // ============ Getter Functions ============

    /**
     * @notice Gets merkle root ID by root hash
     * @param rootHash Merkle root hash
     * @return found Whether the root was found
     * @return rootId ID of the merkle root
     */
    function getMerkleRootIdByHash(bytes32 rootHash)
        external
        view
        returns (bool found, uint256 rootId)
    {
        // M-3 fix: O(1) lookup; stored value is id+1, so 0 means not found
        uint256 storedId = merkleRootToId[rootHash];
        if (storedId == 0) return (false, 0);
        uint256 id = storedId - 1;
        if (id < merkleRoots.length && merkleRoots[id].root == rootHash && merkleRoots[id].isActive) {
            return (true, id);
        }
        return (false, 0);
    }

    /**
     * @notice Gets active merkle roots (paginated)
     * @param offset Starting index
     * @param limit Maximum number of items
     */
    function getActiveMerkleRoots(uint256 offset, uint256 limit)
        external
        view
        returns (MerkleRootInfo[] memory roots, uint256 total)
    {
        // Use cached counter instead of counting loop
        uint256 activeCount = activeRootsCount;

        // Calculate actual limit
        uint256 actualLimit = limit;
        if (offset + limit > activeCount) {
            actualLimit = activeCount > offset ? activeCount - offset : 0;
        }

        roots = new MerkleRootInfo[](actualLimit);
        uint256 currentIndex = 0;
        uint256 addedCount = 0;

        for (uint256 i = 0; i < merkleRoots.length && addedCount < actualLimit; i++) {
            if (merkleRoots[i].isActive) {
                if (currentIndex >= offset) {
                    roots[addedCount] = merkleRoots[i];
                    addedCount++;
                }
                currentIndex++;
            }
        }

        return (roots, activeCount);
    }

    /**
     * @notice Gets all supported tokens
     */
    function getSupportedTokens()
        external
        view
        returns (
            address[] memory tokens,
            string[] memory symbols,
            uint8[] memory decimals,
            bool[] memory active
        )
    {
        uint256 length = supportedTokens.length;
        tokens = new address[](length);
        symbols = new string[](length);
        decimals = new uint8[](length);
        active = new bool[](length);

        for (uint256 i = 0; i < length; i++) {
            address token = supportedTokens[i];
            TokenHandler.TokenInfo storage info = tokenInfo[token];

            tokens[i] = token;
            symbols[i] = info.symbol;
            decimals[i] = info.decimals;
            active[i] = info.isActive;
        }
    }

    /**
     * @notice Gets denominations for a specific token
     */
    function getTokenDenominations(address token)
        external
        view
        returns (uint256[] memory)
    {
        return tokenInfo[token].denominations;
    }

    /**
     * @notice Gets statistics for a token
     */
    function getTokenStats(address token)
        external
        view
        returns (
            uint256 deposited,
            uint256 withdrawn,
            uint256 balance,
            uint256 fees
        )
    {
        deposited = totalDeposited[token];
        withdrawn = totalWithdrawn[token];
        balance = TokenHandler.getBalance(token);
        fees = totalFeesCollected[token];
    }

    /**
     * @notice Checks if multiple nullifiers have been used
     */
    function checkNullifiers(bytes32[] memory nullifierHashes)
        external
        view
        returns (bool[] memory)
    {
        return GetterHelpers.batchCheckNullifiers(nullifiers, nullifierHashes);
    }

    /**
     * @notice Gets withdrawal capacity for a token
     */
    function getWithdrawalCapacity(address token)
        external
        view
        returns (uint256 available, uint256 percentAvailable)
    {
        uint256 balance = TokenHandler.getBalance(token);
        // Reserve relayer gas pool from ETH balance
        if (token == ETH_ADDRESS) {
            balance = balance > relayerGasPool ? balance - relayerGasPool : 0;
        }
        return GetterHelpers.getWithdrawalCapacity(
            balance,
            MIN_LIQUIDITY_RESERVE,
            9000 // 90% max withdrawal
        );
    }

    /**
     * @notice Gets total number of merkle roots
     */
    function getMerkleRootsCount() external view returns (uint256) {
        return merkleRoots.length;
    }

    /**
     * @notice Gets merkle roots for specific token and denomination
     * @param token Token address to filter by
     * @param denomination Denomination to filter by
     * @return roots Array of matching merkle root IDs
     */
    function getMerkleRootsByTokenAndDenomination(
        address token,
        uint256 denomination
    ) external view returns (uint256[] memory roots) {
        uint256 count = 0;

        // First count matching roots
        for (uint256 i = 0; i < merkleRoots.length; i++) {
            if (merkleRoots[i].isActive &&
                merkleRoots[i].token == token &&
                merkleRoots[i].denomination == denomination) {
                count++;
            }
        }

        // Allocate array
        roots = new uint256[](count);
        uint256 index = 0;

        // Populate array
        for (uint256 i = 0; i < merkleRoots.length && index < count; i++) {
            if (merkleRoots[i].isActive &&
                merkleRoots[i].token == token &&
                merkleRoots[i].denomination == denomination) {
                roots[index] = i;
                index++;
            }
        }

        return roots;
    }

    /**
     * @notice Checks if a specific amount is a valid denomination for a token
     */
    function isValidDenomination(address token, uint256 amount)
        external
        view
        returns (bool)
    {
        return TokenHandler.isValidDenomination(tokenInfo[token], amount);
    }

    /**
     * @notice Estimate relay fee breakdown for a given token and amount
     * @dev Used by frontend to show accurate fee estimates before withdrawal.
     *      For native ETH: returns gas reimbursement in ETH (gasEstimate * gasPrice).
     *      For ERC20 with exchange rate set: returns gas cost converted to token units.
     *      For ERC20 without exchange rate: returns 0 gas reimbursement (paid from pool).
     * @param token Token address (ETH_ADDRESS for native)
     * @param amount Withdrawal amount in smallest units
     * @param gasPrice Current gas price in wei (pass tx.gasprice or estimate)
     * @return protocolFee Protocol fee in token units
     * @return gasReimbursementEth Gas reimbursement in wei (only for native ETH)
     * @return gasReimbursementToken Gas reimbursement in token units (only for ERC20 with price set)
     * @return netAmount Estimated amount recipient receives
     * @return feeBps Current protocol fee in basis points
     * @return fixedGas Fixed gas estimate used for ERC20 calculation
     * @return tokenPrice Current ethPricePerToken for this token (0 if not set)
     */
    function getRelayFeeEstimate(
        address token,
        uint256 amount,
        uint256 gasPrice
    ) external view returns (
        uint256 protocolFee,
        uint256 gasReimbursementEth,
        uint256 gasReimbursementToken,
        uint256 netAmount,
        uint256 feeBps,
        uint256 fixedGas,
        uint256 tokenPrice
    ) {
        feeBps = protocolFeeBasisPoints;
        fixedGas = erc20RelayFixedGas;
        protocolFee = (amount * feeBps) / 10000;

        if (token == ETH_ADDRESS) {
            // Native: gas reimbursement = estimated gas * gasPrice
            uint256 estimatedGas = 250000; // ~200k actual + relayGasOverhead
            gasReimbursementEth = estimatedGas * gasPrice;
            uint256 totalFee = protocolFee + gasReimbursementEth;
            netAmount = amount > totalFee ? amount - totalFee : 0;
        } else {
            tokenPrice = ethPricePerToken[token];
            if (tokenPrice > 0) {
                // ERC20 with exchange rate: convert gas to token units
                uint256 gasCostWei = fixedGas * gasPrice;
                gasReimbursementToken = (gasCostWei * tokenPrice) / 1e18;
                uint256 totalFee = protocolFee + gasReimbursementToken;
                netAmount = amount > totalFee ? amount - totalFee : 0;
            } else {
                // ERC20 without exchange rate: gas from pool, user only pays protocol fee
                netAmount = amount > protocolFee ? amount - protocolFee : 0;
            }
        }
    }

    /**
     * @notice Withdraws collected fees for a specific token to the owner
     * @param token The token address for which to withdraw fees
     */
    function withdrawFees(address token) external onlyOwner {
        uint256 availableFees = totalFeesCollected[token] - totalFeesWithdrawn[token];
        require(availableFees > 0, "No fees to withdraw");

        // C-2 fix: Solvency check — ensure withdrawal won't dip into user deposits or relayer pool
        uint256 balance = TokenHandler.getBalance(token);
        if (token == ETH_ADDRESS) {
            uint256 userDeposits = totalDeposited[token] - totalWithdrawn[token];
            require(balance >= availableFees + userDeposits + relayerGasPool, "Insufficient balance: would dip into user deposits or relayer pool");
        } else {
            uint256 userDeposits = totalDeposited[token] - totalWithdrawn[token];
            require(balance >= availableFees + userDeposits, "Insufficient balance: would dip into user deposits");
        }

        totalFeesWithdrawn[token] += availableFees;

        if (token == ETH_ADDRESS) {
            (bool success, ) = owner().call{value: availableFees}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(owner(), availableFees);
        }

        emit FeesWithdrawn(token, availableFees);
    }

    /**
     * @notice Pause the contract
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Emergency withdrawal (only when paused)
     */
    function emergencyWithdraw(address token, uint256 amount)
        external
        onlyOwner
        whenPaused
    {
        if (token == ETH_ADDRESS) {
            (bool success, ) = owner().call{value: amount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(owner(), amount);
        }
        emit EmergencyWithdrawal(token, amount);
    }

    // M-2 fix: Only accept ETH via deposit() or fundRelayerGasPool(), reject bare transfers
    receive() external payable {
        revert("Use deposit() or fundRelayerGasPool()");
    }
}