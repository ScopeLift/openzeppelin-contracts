// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.3.2 (governance/extensions/GovernorCountingSimple.sol)

pragma solidity ^0.8.0;

import "../Governor.sol";

abstract contract GovernorCountingReweight is Governor {

    /**
     * @dev Supported vote types. Matches Governor Bravo ordering.
     */
    enum VoteType {
        Against,
        For,
        Abstain
    }

    struct ProposalVote {
        uint256 againstVotes;
        uint256 forVotes;
        uint256 abstainVotes;
    }

    struct DelegateVote {
        uint256 againstVotes;
        uint256 forVotes;
        uint256 abstainVotes;
        uint256 snapshot;
    }

    // proposalId => total votes
    mapping(uint256 => ProposalVote) private _proposalVotes;

    // proposalId => delegate => votes by delegate
    mapping(uint256 => mapping(address => DelegateVote)) private _delegateVotes;

    /**
     * @dev See {IGovernor-COUNTING_MODE}.
     */
    // solhint-disable-next-line func-name-mixedcase
    function COUNTING_MODE() public pure virtual override returns (string memory) {
        return "support=bravo&quorum=for,abstain";
    }

    /**
     * @dev See {IGovernor-hasVoted}.
     */
    function hasVoted(uint256 proposalId, address account) public view virtual override returns (bool) {
        DelegateVote storage vote = _delegateVotes[proposalId][account];
        return vote.againstVotes > 0 || vote.forVotes > 0 || vote.abstainVotes > 0;
    }

    /**
     * @dev Accessor to the internal vote counts.
     */
    function proposalVotes(uint256 proposalId)
        public
        view
        virtual
        returns (
            uint256 againstVotes,
            uint256 forVotes,
            uint256 abstainVotes
        )
    {
        ProposalVote storage proposalvote = _proposalVotes[proposalId];
        return (proposalvote.againstVotes, proposalvote.forVotes, proposalvote.abstainVotes);
    }

    /**
     * @dev See {Governor-_quorumReached}.
     */
    function _quorumReached(uint256 proposalId) internal view virtual override returns (bool) {
        ProposalVote storage proposalvote = _proposalVotes[proposalId];

        return quorum(proposalSnapshot(proposalId)) <= proposalvote.forVotes + proposalvote.abstainVotes;
    }

    /**
     * @dev See {Governor-_voteSucceeded}. In this module, the forVotes must be strictly over the againstVotes.
     */
    function _voteSucceeded(uint256 proposalId) internal view virtual override returns (bool) {
        ProposalVote storage proposalvote = _proposalVotes[proposalId];

        return proposalvote.forVotes > proposalvote.againstVotes;
    }

    /**
     * @dev See {Governor-_countVote}. In this module, the support follows the `VoteType` enum (from Governor Bravo).
     */
    function _countVote(
        uint256 proposalId,
        address account,
        uint8 support,
        uint256 weight
    ) internal virtual override {
        ProposalVote storage proposalvote = _proposalVotes[proposalId];
        DelegateVote storage delegateVote = _delegateVotes[proposalId][account];

        // The snapshot used for the initial vote is the snapshot of the proposal
        delegateVote.snapshot = proposalSnapshot(proposalId);

        require(!hasVoted(proposalId, account), "GovernorVotingSimple: vote already cast");

        if (support == uint8(VoteType.Against)) {
            proposalvote.againstVotes += weight;
            delegateVote.againstVotes = weight;
        } else if (support == uint8(VoteType.For)) {
            proposalvote.forVotes += weight;
            delegateVote.forVotes = weight;
        } else if (support == uint8(VoteType.Abstain)) {
            proposalvote.abstainVotes += weight;
            delegateVote.abstainVotes = weight;
        } else {
            revert("GovernorVotingSimple: invalid value for enum VoteType");
        }
    }

    function reweightVote(uint256 proposalId, address account, uint256 newSnapshot) public {
        require(state(proposalId) == ProposalState.Active, "GovernorCountingReweight: Cannot reweight unless active");
        require(hasVoted(proposalId, account), "GovernorCountingReweight: Cannot reweight before vote");

        DelegateVote storage delegateVote = _delegateVotes[proposalId][account];
        // TODO: Change to only after proposal snapshot, as delegates could go up and down and we want the min to stick
        require(newSnapshot > delegateVote.snapshot, "GovernorCountingReweight: Cannot reweight to older snapshot");

        uint256 currentWeight;
        // 2 out of 3 are 0, so no risk of overflow
        unchecked {
            currentWeight = delegateVote.againstVotes + delegateVote.forVotes + delegateVote.abstainVotes;
        }

        uint256 newWeight = getVotes(account, newSnapshot);
        require(newWeight < currentWeight, "GovernorCountingReweight: Cannot reweight higher");

        // we've already checked the overflow case
        uint256 weightDrop;
        unchecked {
            weightDrop = currentWeight - newWeight;
        }

        ProposalVote storage proposalVote = _proposalVotes[proposalId];

        if (delegateVote.againstVotes > 0) {
            delegateVote.againstVotes = newWeight;
            proposalVote.againstVotes -= weightDrop;
        } else if (delegateVote.forVotes > 0) {
            delegateVote.forVotes = newWeight;
            proposalVote.forVotes -= weightDrop;
        } else {
            delegateVote.abstainVotes = newWeight;
            proposalVote.abstainVotes -= weightDrop;
        }

        delegateVote.snapshot = newSnapshot;

        // TODO: Emit a Reweight Event
    }
}