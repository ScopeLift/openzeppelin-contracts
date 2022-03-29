const { BN, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { web3 } = require('@openzeppelin/test-helpers/src/setup');
const Enums = require('../../helpers/enums');

const { runGovernorWorkflow } = require('../GovernorWorkflow.behavior');
const { expect, assert } = require('chai');

// we are using this instead of ERC20VotesComp because we need a really big
// token supply to do overflow testing -- more than ERC20VotesComp's maxSupply
const Token = artifacts.require('ERC20VotesMock');

const Governor = artifacts.require('GovernorFractionalMock');
const CallReceiver = artifacts.require('CallReceiverMock');

contract('GovernorCountingFractional', function (accounts) {
  const [owner, proposer, voter1, voter2, voter3, voter4] = accounts;

  const name = 'OZ-Governor';
  const tokenName = 'MockToken';
  const tokenSymbol = 'MTKN';
  // we need a really big supply to do overflow testing
  const tokenSupply = web3.utils.toWei('3000000000000');
  const votingDelay = new BN(4);
  const votingPeriod = new BN(16);

  beforeEach(async function () {
    this.owner = owner;
    this.token = await Token.new(tokenName, tokenSymbol);
    this.mock = await Governor.new(name, this.token.address);
    this.receiver = await CallReceiver.new();
    await this.token.mint(owner, tokenSupply);
    await this.token.delegate(voter1, { from: voter1 });
    await this.token.delegate(voter2, { from: voter2 });
    await this.token.delegate(voter3, { from: voter3 });
    await this.token.delegate(voter4, { from: voter4 });
  });

  it('deployment check', async function () {
    expect(await this.mock.name()).to.be.equal(name);
    expect(await this.mock.token()).to.be.equal(this.token.address);
    expect(await this.mock.votingDelay()).to.be.bignumber.equal(votingDelay);
    expect(await this.mock.votingPeriod()).to.be.bignumber.equal(votingPeriod);
  });

  describe('nominal is unaffected', function () {
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: web3.utils.toWei('1'), support: Enums.VoteType.For, reason: 'This is nice' },
          { voter: voter2, weight: web3.utils.toWei('7'), support: Enums.VoteType.For },
          { voter: voter3, weight: web3.utils.toWei('5'), support: Enums.VoteType.Against },
          { voter: voter4, weight: web3.utils.toWei('2'), support: Enums.VoteType.Abstain },
        ],
      };
    });

    afterEach(async function () {
      expect(await this.mock.hasVoted(this.id, owner)).to.be.equal(false);
      expect(await this.mock.hasVoted(this.id, voter1)).to.be.equal(true);
      expect(await this.mock.hasVoted(this.id, voter2)).to.be.equal(true);

      await this.mock.proposalVotes(this.id).then((result) => {
        for (const [key, value] of Object.entries(Enums.VoteType)) {
          expect(result[`${key.toLowerCase()}Votes`]).to.be.bignumber.equal(
            Object.values(this.settings.voters)
              .filter(({ support }) => support === value)
              .reduce((acc, { weight }) => acc.add(new BN(weight)), new BN('0')),
          );
        }
      });

      const startBlock = new BN(this.receipts.propose.blockNumber).add(votingDelay);
      const endBlock = new BN(this.receipts.propose.blockNumber).add(votingDelay).add(votingPeriod);
      expect(await this.mock.proposalSnapshot(this.id)).to.be.bignumber.equal(startBlock);
      expect(await this.mock.proposalDeadline(this.id)).to.be.bignumber.equal(endBlock);

      expectEvent(this.receipts.propose, 'ProposalCreated', {
        proposalId: this.id,
        proposer,
        targets: this.settings.proposal[0],
        // values: this.settings.proposal[1].map(value => new BN(value)),
        signatures: this.settings.proposal[2].map(() => ''),
        calldatas: this.settings.proposal[2],
        startBlock,
        endBlock,
        description: this.settings.proposal[3],
      });

      this.receipts.castVote.filter(Boolean).forEach((vote) => {
        const { voter } = vote.logs.filter(({ event }) => event === 'VoteCast').find(Boolean).args;
        expectEvent(
          vote,
          'VoteCast',
          this.settings.voters.find(({ address }) => address === voter),
        );
      });
      expectEvent(this.receipts.execute, 'ProposalExecuted', { proposalId: this.id });
      await expectEvent.inTransaction(this.receipts.execute.transactionHash, this.receiver, 'MockFunctionCalled');
    });
    runGovernorWorkflow();
  });

  describe('Voting with fractionalized parameters is properly supported', function () {
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.Against },
          { voter: voter2, weight: voter2Weight }, // do not actually vote, only getting tokens
        ],
        steps: {
          wait: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(voter2Weight).mul(new BN(70)).div(new BN(100)); // 70 percent For
      const againstVotes = new BN(voter2Weight).mul(new BN(20)).div(new BN(100)); // 20 percent Against
      const abstainVotes = new BN(voter2Weight).sub(forVotes).sub(againstVotes);

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 });

      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
      const votes = await this.mock.proposalVotes(this.id);
      expect(votes.forVotes).to.be.bignumber.equal(forVotes);
      expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(againstVotes));
      expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
    });
    runGovernorWorkflow();
  });

  describe('Voting with fractionalized parameters when all votes are Abstain', function () {
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.Against },
          { voter: voter2, weight: voter2Weight }, // do not actually vote, only getting tokens
        ],
        steps: {
          wait: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(0);
      const againstVotes = new BN(0);
      const abstainVotes = new BN(voter2Weight);

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 });

      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
      const votes = await this.mock.proposalVotes(this.id);
      expect(votes.forVotes).to.be.bignumber.equal(forVotes);
      expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(againstVotes));
      expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
    });
    runGovernorWorkflow();
  });

  describe('Voting with fractionalized parameters when all votes are For', function () {
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.Against },
          { voter: voter2, weight: voter2Weight }, // do not actually vote, only getting tokens
        ],
        steps: {
          wait: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(voter2Weight);
      const againstVotes = new BN(0);
      const abstainVotes = new BN(0);

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 });

      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
      const votes = await this.mock.proposalVotes(this.id);
      expect(votes.forVotes).to.be.bignumber.equal(forVotes);
      expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(againstVotes));
      expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
    });
    runGovernorWorkflow();
  });

  describe('Voting with fractionalized parameters when all votes are Against', function () {
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.Against },
          { voter: voter2, weight: voter2Weight }, // do not actually vote, only getting tokens
        ],
        steps: {
          wait: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(0);
      const againstVotes = new BN(voter2Weight);
      const abstainVotes = new BN(0);

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 });

      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
      const votes = await this.mock.proposalVotes(this.id);
      expect(votes.forVotes).to.be.bignumber.equal(forVotes);
      expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(againstVotes));
      expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
    });
    runGovernorWorkflow();
  });

  describe('Voting with fractionalized parameters, multiple voters', function () {
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    const voter3Weight = web3.utils.toWei('14.8');
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.Against },
          // do not specify `support` so setup will not cast their votes, we do that later
          { voter: voter2, weight: voter2Weight },
          { voter: voter3, weight: voter3Weight },
        ],
        steps: {
          wait: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const voter2ForVotes = new BN(voter2Weight).mul(new BN(70)).div(new BN(100)); // 70%
      const voter2AgainstVotes = new BN(voter2Weight).mul(new BN(20)).div(new BN(100)); // 20%
      const voter2AbstainVotes = new BN(voter2Weight).sub(voter2ForVotes).sub(voter2AgainstVotes);

      const voter3ForVotes = new BN(voter3Weight).mul(new BN(15)).div(new BN(100)); // 15%
      const voter3AgainstVotes = new BN(voter3Weight).mul(new BN(80)).div(new BN(100)); // 80%
      const voter3AbstainVotes = new BN(voter3Weight).sub(voter3ForVotes).sub(voter3AgainstVotes);

      // voter 2 casts votes
      const voter2Params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [voter2ForVotes, voter2AgainstVotes]);
      const voter2Tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', voter2Params, { from: voter2 });
      expectEvent(voter2Tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params: voter2Params });
      let votes = await this.mock.proposalVotes(this.id);
      expect(votes.forVotes).to.be.bignumber.equal(voter2ForVotes);
      expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(voter2AgainstVotes));
      expect(votes.abstainVotes).to.be.bignumber.equal(voter2AbstainVotes);

      // voter 2 casts votes
      const voter3Params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [voter3ForVotes, voter3AgainstVotes]);
      const voter3Tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', voter3Params, { from: voter3 });
      expectEvent(voter3Tx, 'VoteCastWithParams', { voter: voter3, weight: voter3Weight, params: voter3Params });
      votes = await this.mock.proposalVotes(this.id);
      expect(votes.forVotes).to.be.bignumber.equal(voter3ForVotes.add(voter2ForVotes));
      expect(votes.againstVotes).to.be.bignumber.equal(
        new BN(voter1Weight).add(voter2AgainstVotes).add(voter3AgainstVotes),
      );
      expect(votes.abstainVotes).to.be.bignumber.equal(voter3AbstainVotes.add(voter2AbstainVotes));
    });

    runGovernorWorkflow();
  });

  describe('Proposals approved through fractional votes can be executed', function () {
    const voter1Weight = web3.utils.toWei('40.0');
    const voter2Weight = web3.utils.toWei('42.0');
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.Against },
          // do not specify `support` so setup will not cast the votes, we do that later
          { voter: voter2, weight: voter2Weight },
        ],
        steps: {
          wait: { enable: false },
          // we're going to take these steps manually in our afterEach function
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(voter2Weight).mul(new BN(98)).div(new BN(100)); // 98%
      const againstVotes = new BN(voter2Weight).mul(new BN(1)).div(new BN(100)); // 1%

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 });

      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });

      // close out the voting period
      await time.advanceBlockTo(this.deadline.addn(1));
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Succeeded);

      // execute the proposal
      const executer = voter2;
      const proposal = this.settings.shortProposal; // defined in GovernorWorkflow.behavior
      const executeFn = this.mock.methods['execute(address[],uint256[],bytes[],bytes32)'];
      const executionTx = await executeFn(...proposal, { from: executer });

      expectEvent(executionTx, 'ProposalExecuted', { proposalId: this.id });
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Executed);
    });

    runGovernorWorkflow();
  });

  describe('Proposals defeated through fractional votes cannot be executed', function () {
    const voter1Weight = web3.utils.toWei('0.8');
    const voter2Weight = web3.utils.toWei('1.0');
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.For },
          // do not specify `support` so setup will not cast the votes, we do that later
          { voter: voter2, weight: voter2Weight },
        ],
        steps: {
          wait: { enable: false },
          // we're going to take these steps manually in our afterEach function
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(voter2Weight).mul(new BN(1)).div(new BN(100)); // 1%
      const againstVotes = new BN(voter2Weight).mul(new BN(90)).div(new BN(100)); // 90%

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 });

      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });

      // close out the voting period
      await time.advanceBlockTo(this.deadline.addn(1));

      // try to execute the proposal
      const executer = voter2;
      const proposal = this.settings.shortProposal; // defined in GovernorWorkflow.behavior
      const executeFn = this.mock.methods['execute(address[],uint256[],bytes[],bytes32)'];
      await expectRevert(executeFn(...proposal, { from: executer }), 'Governor: proposal not successful');

      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Defeated);
    });

    runGovernorWorkflow();
  });

  describe('Fractional votes cannot exceed overall voter weight', function () {
    const voter1Weight = web3.utils.toWei('5.8');
    const voter2Weight = web3.utils.toWei('1.0');
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.For },
          // do not specify `support` so setup will not cast the votes, we do that later
          { voter: voter2, weight: voter2Weight },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(voter2Weight).mul(new BN(56)).div(new BN(100)); // 56%
      const againstVotes = new BN(voter2Weight).mul(new BN(90)).div(new BN(100)); // 90%

      assert(forVotes.add(againstVotes).gt(new BN(voter2Weight)), 'test assumption not met');

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      await expectRevert(
        this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 }),
        'GovernorCountingFractional: Invalid Weight',
      );
    });

    runGovernorWorkflow();
  });

  describe('Protects against voting weight overflow - FOR', function () {
    // To test for overflow, we need a number of votes greater than the max we can store;
    // currently votes are stored as defacto uint85's but we also truncate 3 digits of
    // precision from them.
    // max uint85 == 2^85 - 1 == 3.9e25, multiplying by 1e3 gives us a true max of 3.9e28
    const voter1Weight = web3.utils.toWei('390000000000'); // 3.9e29
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          {
            voter: voter1,
            weight: voter1Weight,
            support: Enums.VoteType.For,
            error: 'VM Exception while processing transaction: reverted with ' +
            'reason string \'SafeCast: value doesn\'t fit in 88 bits\'',
          },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });
    runGovernorWorkflow();
  });

  describe('Protects against voting weight overflow - AGAINST', function () {
    // To test for overflow, we need a number of votes greater than the max we can store;
    // currently votes are stored as defacto uint85's but we also truncate 3 digits of
    // precision from them.
    // max uint85 == 2^85 - 1 == 3.9e25, multiplying by 1e3 gives us a true max of 3.9e28
    const voter1Weight = web3.utils.toWei('390000000000'); // 3.9e29
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          {
            voter: voter1,
            weight: voter1Weight,
            support: Enums.VoteType.Against,
            error: 'VM Exception while processing transaction: reverted with ' +
            'reason string \'SafeCast: value doesn\'t fit in 88 bits\'',
          },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });
    runGovernorWorkflow();
  });

  describe('Protects against voting weight overflow - ABSTAIN', function () {
    // To test for overflow, we need a number of votes greater than the max we can store;
    // currently votes are stored as defacto uint85's but we also truncate 3 digits of
    // precision from them.
    // max uint85 == 2^85 - 1 == 3.9e25, multiplying by 1e3 gives us a true max of 3.9e28
    const voter1Weight = web3.utils.toWei('390000000000'); // 3.9e29
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          {
            voter: voter1,
            weight: voter1Weight,
            support: Enums.VoteType.Abstain,
            error: 'VM Exception while processing transaction: reverted with ' +
            'reason string \'SafeCast: value doesn\'t fit in 88 bits\'',
          },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });
    runGovernorWorkflow();
  });

  describe('Protects against fractional voting weight overflow - FOR', function () {
    const voter1Weight = web3.utils.toWei('1.0');
    // To test for overflow, we need a number of votes greater than the max we can store;
    // currently votes are stored as defacto uint85's but we also truncate 3 digits of
    // precision from them.
    // max uint85 == 2^85 - 1 == 3.9e25, multiplying by 1e3 gives us a true max of 3.9e28
    const voter2Weight = web3.utils.toWei('390000000000'); // 3.9e29
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.For },
          // do not specify `support` so setup will not cast the votes, we do that later
          { voter: voter2, weight: voter2Weight },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(voter2Weight);
      const againstVotes = new BN(0);

      const initVotes = await this.mock.proposalVotes(this.id);
      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);

      await expectRevert(
        this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 }),
        'SafeCast: value doesn\'t fit in 88 bits'
      );

      // The important thing is that the call reverts and no vote counts are changed
      const currentVotes = await this.mock.proposalVotes(this.id);
      expect(currentVotes.forVotes).to.be.bignumber.equal(initVotes.forVotes);
      expect(currentVotes.againstVotes).to.be.bignumber.equal(initVotes.againstVotes);
      expect(currentVotes.abstainVotes).to.be.bignumber.equal(initVotes.abstainVotes);
    });

    runGovernorWorkflow();
  });

  describe('It does not revert when the vote count is high but below the max', function () {
    const voter1Weight = web3.utils.toWei('1.0');
    // We want a number of votes *just* lesser than the max we can store. Currently votes
    // are stored as defacto uint85's but we also truncate 3 digits of precision.
    // max uint85 == 2^85 - 1 == 3.9e25, multiplying by 1e3 gives us a true max of 3.9e28
    const voter2Weight = web3.utils.toWei('38000000000'); // 3.8e28
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.Against },
          // do not specify `support` so setup will not cast the votes, we do that later
          { voter: voter2, weight: voter2Weight },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(voter2Weight);
      const againstVotes = new BN(0);

      const initVotes = await this.mock.proposalVotes(this.id);
      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 })
      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });

      const currentVotes = await this.mock.proposalVotes(this.id);
      expect(currentVotes.forVotes).to.be.bignumber.equal(forVotes);
      // other vote counts shouldn't have changed
      expect(currentVotes.againstVotes).to.be.bignumber.equal(initVotes.againstVotes);
      expect(currentVotes.abstainVotes).to.be.bignumber.equal(initVotes.abstainVotes);
    });

    runGovernorWorkflow();
  });

  describe('Protects against fractional voting weight overflow - AGAINST', function () {
    const voter1Weight = web3.utils.toWei('1.0');
    // To test for overflow, we need a number of votes greater than the max we can store;
    // currently votes are stored as defacto uint85's but we also truncate 3 digits of
    // precision from them.
    // max uint85 == 2^85 - 1 == 3.9e25, multiplying by 1e3 gives us a true max of 3.9e28
    const voter2Weight = web3.utils.toWei('390000000000'); // 3.9e29
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.For },
          // do not specify `support` so setup will not cast the votes, we do that later
          { voter: voter2, weight: voter2Weight },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN(0);
      const againstVotes = new BN(voter2Weight);

      const initVotes = await this.mock.proposalVotes(this.id);
      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      await expectRevert(
        this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 }),
        'SafeCast: value doesn\'t fit in 88 bits'
      );

      // The important thing is that the call reverts and no vote counts are changed
      const currentVotes = await this.mock.proposalVotes(this.id);
      expect(currentVotes.forVotes).to.be.bignumber.equal(initVotes.forVotes);
      expect(currentVotes.againstVotes).to.be.bignumber.equal(initVotes.againstVotes);
      expect(currentVotes.abstainVotes).to.be.bignumber.equal(initVotes.abstainVotes);
    });

    runGovernorWorkflow();
  });

  describe('Protects against fractional voting weight overflow - ABSTAIN', function () {
    const voter1Weight = web3.utils.toWei('1.0');
    // To test for overflow, we need a number of votes greater than the max we can store;
    // currently votes are stored as defacto uint85's but we also truncate 3 digits of
    // precision from them.
    // max uint85 == 2^85 - 1 == 3.9e25, multiplying by 1e3 gives us a true max of 3.9e28
    const voter2Weight = web3.utils.toWei('390000000000'); // 3.9e29
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.For },
          // do not specify `support` so setup will not cast the votes, we do that later
          { voter: voter2, weight: voter2Weight },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      // this will cause us to overflow ABSTAIN
      const forVotes = new BN(0);
      const againstVotes = new BN(0);

      const initVotes = await this.mock.proposalVotes(this.id);
      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      await expectRevert(
        this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 }),
        'SafeCast: value doesn\'t fit in 88 bits'
      );

      // The important thing is that the call reverts and no vote counts are changed
      const currentVotes = await this.mock.proposalVotes(this.id);
      expect(currentVotes.forVotes).to.be.bignumber.equal(initVotes.forVotes);
      expect(currentVotes.againstVotes).to.be.bignumber.equal(initVotes.againstVotes);
      expect(currentVotes.abstainVotes).to.be.bignumber.equal(initVotes.abstainVotes);
    });

    runGovernorWorkflow();
  });

  describe('It strips 6 figures of precision from non-fractional vote weights', function () {
    const voter1Weight = '42424242424242424242424242';
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.For },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const votes = await this.mock.proposalVotes(this.id);
      expect(votes.againstVotes).to.be.bignumber.equal(new BN('0'));
      expect(votes.abstainVotes).to.be.bignumber.equal(new BN('0'));
      expect(votes.forVotes).to.be.bignumber.equal(new BN('42424242424242424242424000'));
    });

    runGovernorWorkflow();
  });

  describe('It correctly adds votes after stripping precision', function () {
    // we strip precision starting ............. here
    const voter1Weight = '33333333333333333333333111';
    const voter2Weight = '11111111111111111111111999';
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.For },
          { voter: voter2, weight: voter2Weight, support: Enums.VoteType.For },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const votes = await this.mock.proposalVotes(this.id);
      expect(votes.againstVotes).to.be.bignumber.equal(new BN('0'));
      expect(votes.abstainVotes).to.be.bignumber.equal(new BN('0'));
      expect(votes.forVotes).to.be.bignumber.equal(new BN('44444444444444444444444000'));
    });

    runGovernorWorkflow();
  });

  describe('It correctly adds fractional votes after stripping precision', function () {
    // we strip precision     v here
    const voter1Weight = '2999900';
    const voter2Weight = '9000100';
    beforeEach(async function () {
      this.settings = {
        proposal: [
          [this.receiver.address],
          [0],
          [this.receiver.contract.methods.mockFunction().encodeABI()],
          '<proposal description>',
        ],
        proposer,
        tokenHolder: owner,
        voters: [
          { voter: voter1, weight: voter1Weight, support: Enums.VoteType.Against },
          // do not specify `support` so setup will not cast the votes, we do that later
          { voter: voter2, weight: voter2Weight },
        ],
        steps: {
          wait: { enable: false },
          queue: { enable: false },
          execute: { enable: false },
        },
      };
    });

    afterEach(async function () {
      expect(await this.mock.state(this.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

      const forVotes = new BN('9000000');
      const againstVotes = new BN('100');
      const abstainVotes = new BN(voter2Weight).sub(forVotes).sub(againstVotes);

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 });

      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
      const votes = await this.mock.proposalVotes(this.id);
      expect(votes.forVotes).to.be.bignumber.equal(forVotes);
      // the votes have been stripped and the (partial) against votes were lost
      expect(votes.againstVotes).to.be.bignumber.equal(new BN('2999000'));
      expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
    });

    runGovernorWorkflow();
  });
});
