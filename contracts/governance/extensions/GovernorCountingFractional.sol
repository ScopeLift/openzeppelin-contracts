// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.X.X (governance/extensions/GovernorCountingFractional.sol)

pragma solidity ^0.8.0;

import "../Governor.sol";
import "../../utils/math/SafeCast.sol";

/**
 * @dev Extension of {Governor} for 3 option fractional vote counting.
 *
 * _Available since v4.X.X_
 */
abstract contract GovernorCountingFractional is Governor {
    /**
     * @dev Supported vote types. Matches Governor Bravo ordering.
     */
    enum VoteType {
        Against,
        For,
        Abstain
    }

    struct ProposalVote {
        uint128 againstVotes;
        uint128 forVotes;
        uint128 abstainVotes;
    }

    mapping(uint256 => ProposalVote) private _proposalVotes;
    mapping(uint256 => mapping(address => bool)) private _proposalVotersHasVoted;

    /**
     * @dev See {IGovernor-COUNTING_MODE}.
     * TODO: Add param for how params is used?
     */
    // solhint-disable-next-line func-name-mixedcase
    function COUNTING_MODE() public pure virtual override returns (string memory) {
        return "support=bravo&quorum=for";
    }

    /**
     * @dev See {IGovernor-hasVoted}.
     */
    function hasVoted(uint256 proposalId, address account) public view virtual override returns (bool) {
        return _proposalVotersHasVoted[proposalId][account];
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

        return quorum(proposalSnapshot(proposalId)) <= proposalvote.forVotes;
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
        uint256 weight,
        bytes memory params
    ) internal virtual override {
        require(!_proposalVotersHasVoted[proposalId][account], "GovernorCountingFractional: vote already cast");
        _proposalVotersHasVoted[proposalId][account] = true;

        if (params.length == 0) {
            _countVoteNominal(proposalId, support, weight);
        } else {
            _countVoteFractional(proposalId, weight, params);
        }
    }

    /**
     * @dev Count votes with full weight
     */
    function _countVoteNominal(
        uint256 proposalId,
        uint8 support,
        uint256 weight
    ) internal {
        if (support == uint8(VoteType.Against)) {
            _proposalVotes[proposalId].againstVotes += SafeCast.toUint128(weight);
        } else if (support == uint8(VoteType.For)) {
            _proposalVotes[proposalId].forVotes += SafeCast.toUint128(weight);
        } else if (support == uint8(VoteType.Abstain)) {
            _proposalVotes[proposalId].abstainVotes += SafeCast.toUint128(weight);
        } else {
            revert("GovernorCountingFractional: invalid value for enum VoteType");
        }
    }

    uint256 constant _VOTEMASK = 0xffffffffffffffffffffffffffffffff; // 128 bits of 0's, 128 bits of 1's

    /**
     * @dev Count votes with fractional weight
     */
    function _countVoteFractional(
        uint256 proposalId,
        uint256 weight,
        bytes memory voteData
    ) internal {
        require(voteData.length == 32, "GovernorCountingFractional: invalid value for params");

        uint256 decoded = abi.decode(voteData, (uint256));
        uint128 forVotes = uint128(decoded >> 128); // keep left-most 128 bits
        uint128 againstVotes = uint128(_VOTEMASK & decoded); // keep right-most 128 bits

        uint128 abstainVotes;
        require(forVotes + againstVotes <= SafeCast.toUint128(weight), "GovernorCountingFractional: Invalid Weight");
        // prior require check ensures no overflow
        unchecked {
            abstainVotes = uint128(weight) - forVotes - againstVotes;
        }

        ProposalVote memory existingProposalVote = _proposalVotes[proposalId];
        ProposalVote memory _proposalVote = ProposalVote(
            existingProposalVote.againstVotes + againstVotes,
            existingProposalVote.forVotes + forVotes,
            existingProposalVote.abstainVotes + abstainVotes
        );

        _proposalVotes[proposalId] = _proposalVote;
    }
}
