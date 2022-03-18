// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.X.X (governance/extensions/GovernorCountingFractional.sol)

pragma solidity ^0.8.0;

import "../Governor.sol";
import "../../utils/math/SafeCast.sol";
import "../../utils/math/SafeMath.sol";

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
        uint80 againstVotes;
        uint80 forVotes;
        uint80 abstainVotes;
    }

    mapping(uint256 => ProposalVote) private _proposalVotes;
    mapping(uint256 => mapping(address => bool)) private _proposalVotersHasVoted;

    /**
     * @dev See {IGovernor-COUNTING_MODE}.
     * TODO: Add param for how params is used?
     */
    // solhint-disable-next-line func-name-mixedcase
    function COUNTING_MODE() public pure virtual override returns (string memory) {
        return "support=bravo&quorum=for,abstain";
    }

    /**
     * @dev Precision of vote counts. This many units of precision is discarded when storing votes.
     */
    function VOTE_PRECISION() pure private returns (uint24 memory) {
      return 1e6;
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
        return (
          SafeMath.tryMul(proposalvote.againstVotes, VOTE_PRECISION()),
          SafeMath.tryMul(proposalvote.forVotes, VOTE_PRECISION()),
          SafeMath.tryMul(proposalvote.abstainVotes, VOTE_PRECISION())
        );
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
        uint256 weight,
        bytes memory params
    ) internal virtual override {
        require(
          !_proposalVotersHasVoted[proposalId][account],
          "GovernorVotingSimple: vote already cast"
        );
        _proposalVotersHasVoted[proposalId][account] = true;

        uint80 forVotes;
        uint80 againstVotes;
        uint80 abstainVotes;

        if (params.length == 0) {
            if (support == uint8(VoteType.Against)) {
                againstVotes = SafeCast.toUint80(weight / VOTE_PRECISION());
            } else if (support == uint8(VoteType.For)) {
                forVotes = SafeCast.toUint80(weight / VOTE_PRECISION());
            } else if (support == uint8(VoteType.Abstain)) {
                abstainVotes = SafeCast.toUint80(weight / VOTE_PRECISION());
            } else {
                revert("GovernorCountingFractional: invalid value for enum VoteType");
            }
        } else {
            uint128 _forVotes;
            uint128 _againstVotes;
            uint128 _abstainVotes;

            (_forVotes, _againstVotes) = abi.decode(params, (uint128, uint128));

            require(
              _forVotes + _againstVotes <= SafeCast.toUint128(weight),
              "GovernorCountingFractional: Invalid Weight"
            );
            // prior require check ensures no overflow and safe casting
            unchecked {
                _abstainVotes = uint128(weight) - _forVotes - _againstVotes;
            }

            forVotes = SafeCast.toUint80(_forVotes / VOTE_PRECISION());
            againstVotes = SafeCast.toUint80(_againstVotes / VOTE_PRECISION());
            abstainVotes = SafeCast.toUint80(_abstainVotes / VOTE_PRECISION());
        }

        ProposalVote memory existingProposalVote = _proposalVotes[proposalId];

        ProposalVote memory _proposalvote = ProposalVote(
          existingProposalVote.againstVotes + againstVotes,
          existingProposalVote.forVotes + forVotes,
          existingProposalVote.abstainVotes + abstainVotes
        );

        _proposalVotes[proposalId] = _proposalvote;
    }
}
