// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.3.2 (governance/extensions/GovernorCountingSimple.sol)

pragma solidity ^0.8.0;

import "./GovernorCountingSimple.sol";

abstract contract GovernorCountingFractional is GovernorCountingSimple {

    struct DelegateVote {
        uint256 againstVotes;
        uint256 forVotes;
        uint256 abstainVotes;
    }

    function castWeightedVote(uint256 proposalId, DelegateVote calldata votes) public virtual returns (uint256) {
        require(state(proposalId) == ProposalState.Active, "Governor: vote not currently active");

        uint256 totalVotes = votes.againstVotes + votes.forVotes + votes.abstainVotes;
        uint256 weight = getVotes(msg.sender, proposalSnapshot(proposalId));

        // Alternatively, we could pass fractions (say, out of 1000 scale facotr, packed in a uint256),
        // and divide the weight here
        require(totalVotes == weight, "GovernorCountingFractional: Invalid vote total");
        _countFactionalVote(proposalId, msg.sender, votes);

        // TODO: Emit a new type of event w/ fractional weights

        return weight;
    }

    // TODO: Add "With Reason" and "By Signature" versions of weighted vote

    function _countFactionalVote(
        uint256 proposalId,
        address account,
        DelegateVote calldata votes
    ) internal virtual {
        // Note: this is possible because we flipped `_proposalVotes` to internal rather than private
        // in GovernorCountingSimple. Without this change, we'd have to inherit from Governor and
        // reimplement the storage. That might be ok if we want to reconcile w/ reweighting anyway.
        ProposalVote storage proposalvote = _proposalVotes[proposalId];

        require(!proposalvote.hasVoted[account], "GovernorCountingFractional: vote already cast");
        proposalvote.hasVoted[account] = true;

        proposalvote.againstVotes += votes.againstVotes;
        proposalvote.forVotes += votes.forVotes;
        proposalvote.abstainVotes += votes.abstainVotes;
    }
}
