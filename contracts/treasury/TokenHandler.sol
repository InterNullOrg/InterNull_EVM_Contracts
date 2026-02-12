// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TokenHandler
 * @notice Library for handling multi-token operations including ETH and ERC20 tokens
 * @dev Manages token transfers, balance checks, and denomination calculations
 */
library TokenHandler {
    using SafeERC20 for IERC20;

    struct TokenInfo {
        string symbol;
        uint8 decimals;
        bool isActive;
        uint256[] denominations; // Store in smallest unit (wei for ETH, smallest unit for tokens)
    }

    address constant ETH_ADDRESS = address(0);

    /**
     * @notice Validates if a denomination is supported for a token
     * @param info Token information
     * @param amount Amount to validate
     * @return isValid Whether the amount matches a valid denomination
     */
    function isValidDenomination(
        TokenInfo storage info,
        uint256 amount
    ) internal view returns (bool) {
        if (!info.isActive) return false;

        for (uint256 i = 0; i < info.denominations.length; i++) {
            if (info.denominations[i] == amount) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Gets the minimum denomination for a token
     * @param info Token information
     * @return minDenom Smallest denomination available for the token
     */
    function getMinimumDenomination(
        TokenInfo storage info
    ) internal view returns (uint256) {
        require(info.denominations.length > 0, "No denominations set");

        uint256 minDenom = info.denominations[0];
        for (uint256 i = 1; i < info.denominations.length; i++) {
            if (info.denominations[i] < minDenom) {
                minDenom = info.denominations[i];
            }
        }
        return minDenom;
    }

    /**
     * @notice Handles token deposits (both ETH and ERC20)
     * @param token Token address (address(0) for ETH)
     * @param depositor Address of the depositor
     * @param amount Amount to deposit
     * @param msgValue Value sent with the transaction (for ETH)
     */
    function handleDeposit(
        address token,
        address depositor,
        uint256 amount,
        uint256 msgValue
    ) internal {
        if (token == ETH_ADDRESS) {
            require(msgValue == amount, "Incorrect ETH amount");
        } else {
            require(msgValue == 0, "ETH sent for token deposit");
            IERC20(token).safeTransferFrom(depositor, address(this), amount);
        }
    }

    /**
     * @notice Handles token withdrawals (both ETH and ERC20)
     * @param token Token address (address(0) for ETH)
     * @param recipient Address to receive tokens
     * @param amount Amount to withdraw
     */
    function handleWithdrawal(
        address token,
        address payable recipient,
        uint256 amount
    ) internal {
        if (token == ETH_ADDRESS) {
            (bool success, ) = recipient.call{value: amount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
    }

    /**
     * @notice Gets the balance of a token for this contract
     * @param token Token address (address(0) for ETH)
     * @return balance Current balance
     */
    function getBalance(address token) internal view returns (uint256) {
        if (token == ETH_ADDRESS) {
            return address(this).balance;
        } else {
            return IERC20(token).balanceOf(address(this));
        }
    }

    /**
     * @notice Converts an amount to its base unit based on decimals
     * @param amount Human-readable amount (e.g., 1 for 1 ETH or 1 USDC)
     * @param decimals Number of decimals for the token
     * @return baseAmount Amount in base units (wei for ETH, smallest unit for tokens)
     */
    function toBaseUnit(
        uint256 amount,
        uint8 decimals
    ) internal pure returns (uint256) {
        return amount * (10 ** uint256(decimals));
    }

    /**
     * @notice Validates denomination array
     * @param denominations Array of denominations to validate
     * @return isValid Whether all denominations are valid (non-zero and unique)
     */
    function validateDenominations(
        uint256[] memory denominations
    ) internal pure returns (bool) {
        if (denominations.length == 0) return false;

        for (uint256 i = 0; i < denominations.length; i++) {
            if (denominations[i] == 0) return false;

            // Check for duplicates
            for (uint256 j = i + 1; j < denominations.length; j++) {
                if (denominations[i] == denominations[j]) return false;
            }
        }
        return true;
    }

    /**
     * @notice Calculates fee for a withdrawal
     * @param amount Withdrawal amount
     * @param isTokenWithdrawal Whether this is a token withdrawal
     * @param isCrossChain Whether this is a cross-chain withdrawal
     * @return fee Fee amount in basis points
     */
    function calculateFee(
        uint256 amount,
        bool isTokenWithdrawal,
        bool isCrossChain
    ) internal pure returns (uint256) {
        uint256 feeBasisPoints = 0;

        // Base fee for token withdrawals
        if (isTokenWithdrawal) {
            feeBasisPoints = 10; // 0.1%
        }

        // Additional fee for cross-chain
        if (isCrossChain) {
            feeBasisPoints += 40; // Additional 0.4% for cross-chain
        }

        return (amount * feeBasisPoints) / 10000;
    }
}