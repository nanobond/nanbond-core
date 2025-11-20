// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title Nanobond ERC-1967 Minimal Proxy (UUPS-compatible)
 * @author Nanobond
 *
 * - Minimal, production-oriented ERC-1967 proxy.
 * - No admin functions on the proxy itself — UUPS upgrade logic lives in the implementation.
 * - Stores implementation at the EIP-1967 slot and delegates all calls.
 * - Constructor optionally executes an initialization call on the implementation.
 *
 * Usage:
 * 1. Deploy implementation (AdminV1).
 * 2. Deploy this proxy with implementation address and optional init calldata.
 * 3. All calls to the proxy are delegatecalled to the current implementation.
 *
 * SECURITY NOTES:
 * - The implementation must implement _authorizeUpgrade (UUPS) and secure upgrades (multisig/timelock).
 * - Operator MUST ensure the implementation is trusted before pointing the proxy at it.
 * - This proxy intentionally keeps surface-area minimal to make audits easier.
 */
contract NanobondProxy {
    // EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// Emitted when the proxy is deployed and implementation set.
    event ImplementationSet(address indexed implementation, bytes initData);

    /**
     * @dev Deploy proxy pointing to `_implementation`. If `_data` is non-empty,
     * perform a delegatecall to `_implementation` with `_data` (initializer).
     */
    constructor(address _implementation, bytes memory _data) payable {
        require(_implementation != address(0), "NanobondProxy: impl=0");

        // Set implementation slot
        assembly {
            sstore(IMPLEMENTATION_SLOT, _implementation)
        }

        // If init data supplied, delegatecall into implementation for initialization
        if (_data.length > 0) {
            (bool ok, bytes memory ret) = _implementation.delegatecall(_data);
            // bubble up revert message if init fails
            if (!ok) {
                // If ret contains a revert reason, revert with it
                assembly {
                    let size := mload(ret)
                    revert(add(ret, 32), size)
                }
            }
        }

        emit ImplementationSet(_implementation, _data);
    }

    /**
     * @notice Returns the current implementation address.
     * @dev view helper — reads from EIP-1967 slot.
     */
    function implementation() public view returns (address impl) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            impl := sload(slot)
        }
    }

    /**
     * @dev Fallback that delegates calls to the implementation. Will run if no other
     * function in the proxy matches the call data.
     */
    fallback() external payable {
        _delegate();
    }

    /// @dev Allow receiving native currency (HBAR) transfers
    receive() external payable {}

    /**
     * @dev Internal delegate to current implementation.
     */
    function _delegate() internal {
        address impl = implementation();
        require(impl != address(0), "NanobondProxy: impl not set");

        assembly {
            // copy calldata to memory starting at position 0
            calldatacopy(0, 0, calldatasize())

            // delegatecall to the implementation
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)

            // copy returned data
            let size := returndatasize()
            returndatacopy(0, 0, size)

            // forward return / revert
            switch result
            case 0 { revert(0, size) }
            default { return(0, size) }
        }
    }
}
