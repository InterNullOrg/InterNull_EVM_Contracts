// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title MerkleVerifier
 * @dev Library for verifying Merkle proofs for public keys
 */
library MerkleVerifier {
    
    // Domain separator for unpaired leaves to prevent second preimage attacks
    bytes32 private constant UNPAIRED_LEAF_DOMAIN = bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF);
    
    /**
     * @dev Verify Merkle proof for a public key
     * @param merkleRoot The Merkle root
     * @param publicKey The public key to verify
     * @param proof The Merkle proof
     * @param keyIndex The index of the key in the tree
     * @return True if proof is valid
     */
    function verifyMerkleProof(
        bytes32 merkleRoot,
        bytes32[67] calldata publicKey,
        bytes32[] calldata proof,
        uint256 keyIndex
    ) internal pure returns (bool) {
        // Hash the public key to get the leaf
        bytes32 leaf = keccak256(abi.encodePacked(publicKey));
        
        return verifyProof(merkleRoot, leaf, proof, keyIndex);
    }
    
    /**
     * @dev Verify Merkle proof for any leaf
     * @param merkleRoot The Merkle root
     * @param leaf The leaf to verify
     * @param proof The Merkle proof
     * @param index The index of the leaf in the tree
     * @return True if proof is valid
     */
    function verifyProof(
        bytes32 merkleRoot,
        bytes32 leaf,
        bytes32[] calldata proof,
        uint256 index
    ) internal pure returns (bool) {
        bytes32 computedHash = leaf;
        uint256 currentIndex = index;
        
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            
            if (currentIndex % 2 == 0) {
                // Left side
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                // Right side
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
            
            currentIndex = currentIndex / 2;
        }
        
        return computedHash == merkleRoot;
    }
    
    /**
     * @dev Calculate Merkle root from leaves
     * @param leaves Array of leaf hashes
     * @return Merkle root
     */
    function calculateMerkleRoot(bytes32[] calldata leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "MerkleVerifier: empty leaves array");
        
        if (leaves.length == 1) {
            return leaves[0];
        }
        
        bytes32[] memory currentLevel = new bytes32[](leaves.length);
        for (uint256 i = 0; i < leaves.length; i++) {
            currentLevel[i] = leaves[i];
        }
        
        while (currentLevel.length > 1) {
            bytes32[] memory nextLevel = new bytes32[]((currentLevel.length + 1) / 2);
            
            for (uint256 i = 0; i < nextLevel.length; i++) {
                uint256 leftIndex = i * 2;
                uint256 rightIndex = leftIndex + 1;
                
                if (rightIndex < currentLevel.length) {
                    nextLevel[i] = keccak256(abi.encodePacked(currentLevel[leftIndex], currentLevel[rightIndex]));
                } else {
                    nextLevel[i] = keccak256(abi.encodePacked(currentLevel[leftIndex], UNPAIRED_LEAF_DOMAIN));
                }
            }
            
            currentLevel = nextLevel;
        }
        
        return currentLevel[0];
    }
    
    /**
     * @dev Generate Merkle proof for a leaf
     * @param leaves Array of all leaves
     * @param targetIndex Index of the target leaf
     * @return proof Merkle proof for the target leaf
     */
    function generateMerkleProof(
        bytes32[] calldata leaves,
        uint256 targetIndex
    ) internal pure returns (bytes32[] memory proof) {
        require(targetIndex < leaves.length, "MerkleVerifier: index out of bounds");
        
        // Calculate the depth of the tree
        uint256 depth = 0;
        uint256 temp = leaves.length;
        while (temp > 1) {
            temp = (temp + 1) / 2;
            depth++;
        }
        
        proof = new bytes32[](depth);
        
        bytes32[] memory currentLevel = new bytes32[](leaves.length);
        for (uint256 i = 0; i < leaves.length; i++) {
            currentLevel[i] = leaves[i];
        }
        
        uint256 currentIndex = targetIndex;
        uint256 proofIndex = 0;
        
        while (currentLevel.length > 1) {
            bytes32[] memory nextLevel = new bytes32[]((currentLevel.length + 1) / 2);
            
            // Add sibling to proof
            if (currentIndex % 2 == 0) {
                // Target is left child, sibling is right
                if (currentIndex + 1 < currentLevel.length) {
                    proof[proofIndex] = currentLevel[currentIndex + 1];
                } else {
                    proof[proofIndex] = UNPAIRED_LEAF_DOMAIN;
                }
            } else {
                // Target is right child, sibling is left
                proof[proofIndex] = currentLevel[currentIndex - 1];
            }
            
            // Build next level
            for (uint256 i = 0; i < nextLevel.length; i++) {
                uint256 leftIndex = i * 2;
                uint256 rightIndex = leftIndex + 1;
                
                if (rightIndex < currentLevel.length) {
                    nextLevel[i] = keccak256(abi.encodePacked(currentLevel[leftIndex], currentLevel[rightIndex]));
                } else {
                    nextLevel[i] = keccak256(abi.encodePacked(currentLevel[leftIndex], UNPAIRED_LEAF_DOMAIN));
                }
            }
            
            currentLevel = nextLevel;
            currentIndex = currentIndex / 2;
            proofIndex++;
        }
        
        // Resize proof array to actual length
        bytes32[] memory finalProof = new bytes32[](proofIndex);
        for (uint256 i = 0; i < proofIndex; i++) {
            finalProof[i] = proof[i];
        }
        
        // Validate the generated proof before returning
        bytes32 merkleRoot = currentLevel[0];
        bool isValid = _verifyProofMemory(merkleRoot, leaves[targetIndex], finalProof, targetIndex);
        require(isValid, "MerkleVerifier: generated proof is invalid");
        
        return finalProof;
    }
    
    /**
     * @dev Internal function to verify proof with memory array
     * @param merkleRoot The Merkle root
     * @param leaf The leaf to verify
     * @param proof The Merkle proof (memory array)
     * @param index The index of the leaf in the tree
     * @return True if proof is valid
     */
    function _verifyProofMemory(
        bytes32 merkleRoot,
        bytes32 leaf,
        bytes32[] memory proof,
        uint256 index
    ) internal pure returns (bool) {
        bytes32 computedHash = leaf;
        uint256 currentIndex = index;
        
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            
            if (currentIndex % 2 == 0) {
                // Left side
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                // Right side
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
            
            currentIndex = currentIndex / 2;
        }
        
        return computedHash == merkleRoot;
    }
    
    /**
     * @dev Verify Merkle proof with a direct leaf hash and index (for ECDSA)
     * This is used by TreasuryECDSA where the leaf is already a hash
     * @param merkleRoot The Merkle root
     * @param leaf The leaf hash to verify
     * @param proof The Merkle proof
     * @param index The index of the leaf in the tree
     * @return True if proof is valid
     */
    function verifyMerkleProofWithIndex(
        bytes32 merkleRoot,
        bytes32 leaf,
        bytes32[] calldata proof,
        uint256 index
    ) internal pure returns (bool) {
        return verifyProof(merkleRoot, leaf, proof, index);
    }
}