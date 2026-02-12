// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title GetterHelpers
 * @notice Library providing efficient getter functions for the Treasury
 * @dev Optimized view functions to reduce gas costs and improve UX
 */
library GetterHelpers {
    struct MerkleRootInfo {
        bytes32 root;
        uint256 timestamp;
        bool isActive;
        uint256 totalKeys;
        uint256 usedKeys;
    }

    struct DepositInfo {
        address depositor;
        address token;
        uint256 amount;
        uint256 timestamp;
        bytes32 commitment;
    }

    struct WithdrawalInfo {
        address recipient;
        address token;
        uint256 amount;
        uint256 timestamp;
        bytes32 nullifierHash;
        uint256 fee;
    }

    /**
     * @notice Finds merkle root ID by the root hash
     * @param roots Array of all merkle roots
     * @param rootHash The merkle root hash to search for
     * @return found Whether the root was found
     * @return rootId The ID of the found root
     */
    function findRootIdByHash(
        MerkleRootInfo[] storage roots,
        bytes32 rootHash
    ) internal view returns (bool found, uint256 rootId) {
        for (uint256 i = 0; i < roots.length; i++) {
            if (roots[i].root == rootHash && roots[i].isActive) {
                return (true, i);
            }
        }
        return (false, 0);
    }

    /**
     * @notice Gets paginated list of active merkle roots
     * @param roots Array of all merkle roots
     * @param offset Starting index
     * @param limit Maximum number of items to return
     * @return activeRoots Array of active merkle root info
     * @return total Total number of active roots
     */
    function getActiveMerkleRoots(
        MerkleRootInfo[] storage roots,
        uint256 offset,
        uint256 limit
    ) internal view returns (
        MerkleRootInfo[] memory activeRoots,
        uint256 total
    ) {
        // First, count active roots
        uint256 activeCount = 0;
        for (uint256 i = 0; i < roots.length; i++) {
            if (roots[i].isActive) {
                activeCount++;
            }
        }

        // Calculate actual limit
        uint256 actualLimit = limit;
        if (offset + limit > activeCount) {
            actualLimit = activeCount > offset ? activeCount - offset : 0;
        }

        activeRoots = new MerkleRootInfo[](actualLimit);
        uint256 currentIndex = 0;
        uint256 addedCount = 0;

        for (uint256 i = 0; i < roots.length && addedCount < actualLimit; i++) {
            if (roots[i].isActive) {
                if (currentIndex >= offset) {
                    activeRoots[addedCount] = roots[i];
                    addedCount++;
                }
                currentIndex++;
            }
        }

        return (activeRoots, activeCount);
    }

    /**
     * @notice Checks if a nullifier has been used
     * @param nullifiers Mapping of nullifier hashes to usage status
     * @param nullifierHash The nullifier hash to check
     * @return used Whether the nullifier has been used
     */
    function isNullifierUsed(
        mapping(bytes32 => bool) storage nullifiers,
        bytes32 nullifierHash
    ) internal view returns (bool) {
        return nullifiers[nullifierHash];
    }

    /**
     * @notice Gets statistics for a specific token
     * @param totalDeposited Total amount deposited for the token
     * @param totalWithdrawn Total amount withdrawn for the token
     * @param balance Current balance of the token
     * @return deposited Total amount deposited
     * @return withdrawn Total amount withdrawn
     * @return currentBalance Current balance
     * @return netFlow Net flow (deposits - withdrawals)
     */
    function getTokenStats(
        uint256 totalDeposited,
        uint256 totalWithdrawn,
        uint256 balance
    ) internal pure returns (
        uint256 deposited,
        uint256 withdrawn,
        uint256 currentBalance,
        uint256 netFlow
    ) {
        deposited = totalDeposited;
        withdrawn = totalWithdrawn;
        currentBalance = balance;
        netFlow = totalDeposited > totalWithdrawn ?
                  totalDeposited - totalWithdrawn : 0;

        return (deposited, withdrawn, currentBalance, netFlow);
    }

    /**
     * @notice Batch check multiple nullifiers
     * @param nullifiers Mapping of nullifier hashes to usage status
     * @param nullifierHashes Array of nullifier hashes to check
     * @return results Array of boolean results for each nullifier
     */
    function batchCheckNullifiers(
        mapping(bytes32 => bool) storage nullifiers,
        bytes32[] memory nullifierHashes
    ) internal view returns (bool[] memory results) {
        results = new bool[](nullifierHashes.length);
        for (uint256 i = 0; i < nullifierHashes.length; i++) {
            results[i] = nullifiers[nullifierHashes[i]];
        }
        return results;
    }

    /**
     * @notice Gets summary of all supported tokens
     * @param tokenAddresses Array of token addresses
     * @param tokenSymbols Array of token symbols
     * @param tokenActive Array of token active status
     * @return count Number of active tokens
     * @return activeTokens Array of active token addresses
     * @return symbols Array of active token symbols
     */
    function getActiveTokensSummary(
        address[] storage tokenAddresses,
        mapping(address => string) storage tokenSymbols,
        mapping(address => uint8) storage /* tokenDecimals */,
        mapping(address => bool) storage tokenActive
    ) internal view returns (
        uint256 count,
        address[] memory activeTokens,
        string[] memory symbols
    ) {
        // Count active tokens
        count = 0;
        for (uint256 i = 0; i < tokenAddresses.length; i++) {
            if (tokenActive[tokenAddresses[i]]) {
                count++;
            }
        }

        // Populate arrays
        activeTokens = new address[](count);
        symbols = new string[](count);
        uint256 currentIndex = 0;

        for (uint256 i = 0; i < tokenAddresses.length; i++) {
            if (tokenActive[tokenAddresses[i]]) {
                activeTokens[currentIndex] = tokenAddresses[i];
                symbols[currentIndex] = tokenSymbols[tokenAddresses[i]];
                currentIndex++;
            }
        }

        return (count, activeTokens, symbols);
    }

    /**
     * @notice Validates if amount matches any denomination
     * @param denominations Array of valid denominations
     * @param amount Amount to validate
     * @return valid Whether the amount is valid
     * @return denominationIndex Index of the matching denomination
     */
    function validateAndGetDenominationIndex(
        uint256[] storage denominations,
        uint256 amount
    ) internal view returns (bool valid, uint256 denominationIndex) {
        for (uint256 i = 0; i < denominations.length; i++) {
            if (denominations[i] == amount) {
                return (true, i);
            }
        }
        return (false, 0);
    }

    /**
     * @notice Gets withdrawal limits and remaining capacity
     * @param balance Current token balance
     * @param minReserve Minimum reserve requirement
     * @param maxWithdrawalPercent Maximum withdrawal percentage (basis points)
     * @return availableAmount Amount available for withdrawal
     * @return percentAvailable Percentage available (basis points)
     */
    function getWithdrawalCapacity(
        uint256 balance,
        uint256 minReserve,
        uint256 maxWithdrawalPercent
    ) internal pure returns (
        uint256 availableAmount,
        uint256 percentAvailable
    ) {
        if (balance <= minReserve) {
            return (0, 0);
        }

        availableAmount = balance - minReserve;
        uint256 maxAllowed = (balance * maxWithdrawalPercent) / 10000;

        if (availableAmount > maxAllowed) {
            availableAmount = maxAllowed;
        }

        percentAvailable = balance > 0 ?
                          (availableAmount * 10000) / balance : 0;

        return (availableAmount, percentAvailable);
    }
}