// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.4.1 (governance/IGovernor.sol)

pragma solidity ^0.8.0;

import "./IGovernor.sol";

abstract contract IGovernorWithParams is IGovernor {

    /**
     * @dev Cast a vote with a reason and additional encoded parameters
     *
     * Emits a {VoteCast} event.
     */
    function castVoteWithReasonAndParams(
        uint256 proposalId,
        uint8 support,
        string calldata reason,
        bytes memory params
    ) public virtual returns (uint256 balance);
}