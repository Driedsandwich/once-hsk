// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract OnceLedger {
    struct Entry {
        address registrar;
        uint64 registeredAt;
        bool settled;
        bytes32 termsHash;
        bytes32 settlementHash;
        uint64 settledAt;
    }

    mapping(bytes32 => Entry) private entries;

    error AlreadyRegistered();
    error NotRegistrar();
    error AlreadySettled();

    event Registered(bytes32 indexed requestId, address indexed registrar, bytes32 termsHash);
    event Settled(bytes32 indexed requestId, bytes32 settlementHash);

    function register(bytes32 requestId, bytes32 termsHash) external {
        Entry storage entry = entries[requestId];
        if (entry.registrar != address(0)) revert AlreadyRegistered();
        entry.registrar = msg.sender;
        entry.termsHash = termsHash;
        entry.registeredAt = uint64(block.timestamp);
        emit Registered(requestId, msg.sender, termsHash);
    }

    function markSettled(bytes32 requestId, bytes32 settlementHash) external {
        Entry storage entry = entries[requestId];
        if (entry.registrar != msg.sender) revert NotRegistrar();
        if (entry.settled) revert AlreadySettled();
        entry.settled = true;
        entry.settlementHash = settlementHash;
        entry.settledAt = uint64(block.timestamp);
        emit Settled(requestId, settlementHash);
    }

    function get(bytes32 requestId) external view returns (
        address registrar, bytes32 termsHash, bytes32 settlementHash,
        uint64 registeredAt, uint64 settledAt
    ) {
        Entry storage entry = entries[requestId];
        return (entry.registrar, entry.termsHash, entry.settlementHash,
                entry.registeredAt, entry.settledAt);
    }
}
