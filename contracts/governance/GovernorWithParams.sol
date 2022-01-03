// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.4.1 (governance/Governor.sol)

pragma solidity ^0.8.0;

import "./Governor.sol";
import "./IGovernorWithParams.sol";

abstract contract GovernorWithParams is Governor, IGovernorWithParams {
    using Timers for Timers.BlockNumber;

    function _countVoteWithParams(
        uint256 proposalId,
        address account,
        uint8 support,
        uint256 weight,
        bytes memory params
    ) internal virtual;

    function _countVote(
        uint256 proposalId,
        address account,
        uint8 support,
        uint256 weight
    ) internal override {
        _countVoteWithParams(proposalId, account, support, weight, "");
    }

    /**
     * @dev See {IGovernor-castVoteWithReasonAndParams}.
     */
    function castVoteWithReasonAndParams(
        uint256 proposalId,
        uint8 support,
        string calldata reason,
        bytes memory params
    ) public virtual override returns (uint256) {
        address account = _msgSender();

        ProposalCore storage proposal = _proposals[proposalId];
        require(state(proposalId) == ProposalState.Active, "Governor: vote not currently active");

        uint256 weight = getVotes(account, proposal.voteStart.getDeadline());
        _countVoteWithParams(proposalId, account, support, weight, params);

        emit VoteCast(account, proposalId, support, weight, reason);

        return weight;
    }

    function supportsInterface(bytes4 interfaceId) public view virtual override(IERC165, Governor) returns (bool) {
        return
            interfaceId == type(IGovernorWithParams).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
