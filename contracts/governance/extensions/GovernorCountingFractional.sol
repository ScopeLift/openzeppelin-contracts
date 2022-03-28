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

    // proposal id --> encoded votes
    mapping(uint256 => uint256) private _proposalVotes;

    // proposal id --> (address --> whether the address voted)
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
    function _votePrecision() pure private returns (uint24) {
      return 1e3;
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
        uint256 _forVotes;
        uint256 _againstVotes;
        uint256 _abstainVotes;

        (
          _forVotes,
          _againstVotes,
          _abstainVotes
        ) = _decodeVotes(_proposalVotes[proposalId]);

        return (
          _againstVotes * _votePrecision(),
          _forVotes * _votePrecision(),
          _abstainVotes * _votePrecision()
        );
    }

    /**
     * @dev See {Governor-_quorumReached}.
     */
    function _quorumReached(uint256 proposalId) internal view virtual override returns (bool) {
        uint256 _forVotes;
        uint256 _abstainVotes;

        (
          _forVotes,
          , // _againstVotes
          _abstainVotes
        ) = _decodeVotes(_proposalVotes[proposalId]);

        return quorum(proposalSnapshot(proposalId)) <= (
          _forVotes + _abstainVotes
        ) * _votePrecision();
    }

    /**
     * @dev See {Governor-_voteSucceeded}. In this module, the forVotes must be strictly over the againstVotes.
     */
    function _voteSucceeded(uint256 proposalId) internal view virtual override returns (bool) {
        uint256 _forVotes;
        uint256 _againstVotes;

        (
          _forVotes,
          _againstVotes
          , // _abstainVotes
        ) = _decodeVotes(_proposalVotes[proposalId]);

        return _forVotes > _againstVotes;
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
                againstVotes = SafeCast.toUint80(weight / _votePrecision());
            } else if (support == uint8(VoteType.For)) {
                forVotes = SafeCast.toUint80(weight / _votePrecision());
            } else if (support == uint8(VoteType.Abstain)) {
                abstainVotes = SafeCast.toUint80(weight / _votePrecision());
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

            forVotes = SafeCast.toUint80(_forVotes / _votePrecision());
            againstVotes = SafeCast.toUint80(_againstVotes / _votePrecision());
            abstainVotes = SafeCast.toUint80(_abstainVotes / _votePrecision());
        }

        uint256 existingProposalVote = _proposalVotes[proposalId];

        uint256 _existingForVotes;
        uint256 _existingAgainstVotes;
        uint256 _existingAbstainVotes;

        (
          _existingForVotes,
          _existingAgainstVotes,
          _existingAbstainVotes
        ) = _decodeVotes(existingProposalVote);

        _proposalVotes[proposalId] = _encodeVotes(
          _existingForVotes + forVotes,
          _existingAgainstVotes + againstVotes,
          _existingAbstainVotes + abstainVotes
        );
    }

    uint256 public constant BITS = 85;
    uint256 public constant MAX_UINT85 = 2 ** BITS - 1;
    uint256 public constant MASK = 0x1fffffffffffffffffffff;

    function _encodeVotes(
      uint256 _for,
      uint256 _against,
      uint256 _abstain
    ) internal pure returns(uint256) {
      require(_for <= MAX_UINT85, "too many for votes");
      require(_against <= MAX_UINT85, "too many against votes");
      require(_abstain <= MAX_UINT85, "too many abstain votes");

      // Shift by BITS to move the value to the correct position.
      // x << y is equivalent to x * 2 ** y.
      uint256 _shiftedFor = _for;
      uint256 _shiftedAgainst = _against << BITS;
      uint256 _shiftedAbstain = _abstain << BITS * 2;

      return _shiftedAbstain | _shiftedAgainst | _shiftedFor;
    }

    function _decodeVotes(uint256 encodedVotes) internal pure returns (
      uint256 _for,
      uint256 _against,
      uint256 _abstain
    ) {
      _for     = MASK & encodedVotes;
      _against = MASK & encodedVotes >> BITS;
      _abstain = MASK & encodedVotes >> BITS * 2;
    }
}
