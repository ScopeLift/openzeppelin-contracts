const { BN, constants, expectEvent } = require('@openzeppelin/test-helpers');
const { web3 } = require('@openzeppelin/test-helpers/src/setup');
const Enums = require('../../helpers/enums');
const ethSigUtil = require('eth-sig-util');
const Wallet = require('ethereumjs-wallet').default;
const { EIP712Domain } = require('../../helpers/eip712');
const { fromRpcSig } = require('ethereumjs-util');

const { runGovernorWorkflow } = require('../GovernorWorkflow.behavior');
const { expect } = require('chai');

const Token = artifacts.require('ERC20VotesCompMock');
const Governor = artifacts.require('GovernorFractionalMock');
const CallReceiver = artifacts.require('CallReceiverMock');

contract('GovernorCountingFractional', function (accounts) {
  const [owner, proposer, voter1, voter2, voter3, voter4] = accounts;

  const name = 'OZ-Governor';
  const version = '1';
  const tokenName = 'MockToken';
  const tokenSymbol = 'MTKN';
  const tokenSupply = web3.utils.toWei('100');
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

      const forVotes = (new BN(voter2Weight)).mul(new BN(70)).div(new BN(100)); // 70 percent For
      const againstVotes = (new BN(voter2Weight)).mul(new BN(20)).div(new BN(100)); // 20 percent Against
      const abstainVotes = (new BN(voter2Weight)).sub(forVotes).sub(againstVotes);

      const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
      const tx = await this.mock.castVoteWithReasonAndParams(this.id, 0, '', params, { from: voter2 });

      expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
      const votes = await this.mock.proposalVotes(this.id);
      expect(votes.forVotes).to.be.bignumber.equal(forVotes);
      expect(votes.againstVotes).to.be.bignumber.equal((new BN(voter1Weight)).add(againstVotes))
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
      expect(votes.againstVotes).to.be.bignumber.equal((new BN(voter1Weight)).add(againstVotes))
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
      expect(votes.againstVotes).to.be.bignumber.equal((new BN(voter1Weight)).add(againstVotes))
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
      expect(votes.againstVotes).to.be.bignumber.equal((new BN(voter1Weight)).add(againstVotes))
      expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
    });
    runGovernorWorkflow();
  });

  // TODO: more than 1 fractional voter
  // TODO: perform fractional votes *then queue and execute*
});
