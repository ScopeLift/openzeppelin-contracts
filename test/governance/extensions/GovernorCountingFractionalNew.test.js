const { BN, expectEvent, expectRevert } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');
const ethSigUtil = require('eth-sig-util');
const Wallet = require('ethereumjs-wallet').default;
const { fromRpcSig } = require('ethereumjs-util');
const Enums = require('../../helpers/enums');
const { EIP712Domain } = require('../../helpers/eip712');
const { GovernorHelper } = require('../../helpers/governance');

const {
  shouldSupportInterfaces,
} = require('../../utils/introspection/SupportsInterface.behavior');

const Token = artifacts.require('ERC20VotesMock');
const Governor = artifacts.require('GovernorFractionalMock');
const CallReceiver = artifacts.require('CallReceiverMock');
const ERC721Mock = artifacts.require('ERC721Mock');
const ERC1155Mock = artifacts.require('ERC1155Mock');

contract('GovernorCountingFractional', function (accounts) {
  const [owner, proposer, voter1, voter2, voter3, voter4] = accounts;

  const name = 'OZ-Governor';
  const tokenName = 'MockToken';
  const tokenSymbol = 'MTKN';
  const tokenSupply = web3.utils.toWei('100');
  const votingDelay = new BN(4);
  const votingPeriod = new BN(16);

  beforeEach(async function () {
    this.chainId = await web3.eth.getChainId();
    this.owner = owner;
    this.token = await Token.new(tokenName, tokenSymbol);
    this.mock = await Governor.new(name, this.token.address);
    this.receiver = await CallReceiver.new();
    this.helper = new GovernorHelper(this.mock);

    await this.token.mint(owner, tokenSupply);
    await this.helper.delegate({ token: this.token, to: voter1 });
    await this.helper.delegate({ token: this.token, to: voter2 });
    await this.helper.delegate({ token: this.token, to: voter3 });
    await this.helper.delegate({ token: this.token, to: voter4 });

    this.proposal = this.helper.setProposal([
      {
        target: this.receiver.address,
        data: this.receiver.contract.methods.mockFunction().encodeABI(),
        value: 0,
      },
    ], '<proposal description>');

    expect(await this.mock.hasVoted(this.proposal.id, owner)).to.be.equal(false);
    expect(await this.mock.hasVoted(this.proposal.id, voter1)).to.be.equal(false);
    expect(await this.mock.hasVoted(this.proposal.id, voter2)).to.be.equal(false);
    expect(await this.mock.hasVoted(this.proposal.id, voter3)).to.be.equal(false);
    expect(await this.mock.hasVoted(this.proposal.id, voter4)).to.be.equal(false);
  });

  shouldSupportInterfaces([ // TODO should it?
    'ERC165',
    'ERC1155Receiver',
    'Governor',
    'GovernorWithParams',
  ]);

  it('deployment check', async function () {
    expect(await this.mock.name()).to.be.equal(name);
    expect(await this.mock.token()).to.be.equal(this.token.address);
    expect(await this.mock.votingDelay()).to.be.bignumber.equal(votingDelay);
    expect(await this.mock.votingPeriod()).to.be.bignumber.equal(votingPeriod);
    expect(await this.mock.quorum(0)).to.be.bignumber.equal('0');
    expect(await this.mock.COUNTING_MODE()).to.be.equal('support=bravo&quorum=for');
  });

  it('nominal is unaffected', async function () {
    const initGovBalance = await web3.eth.getBalance(this.mock.address);
    const initReceiverBalance = await web3.eth.getBalance(this.receiver.address);

    const voter1Weight = web3.utils.toWei('10');
    const voter2Weight = web3.utils.toWei('7');
    const voter3Weight = web3.utils.toWei('5');
    const voter4Weight = web3.utils.toWei('2');

    // fund the voters' accounts
    await this.token.transfer(voter1, voter1Weight, { from: owner });
    await this.token.transfer(voter2, voter2Weight, { from: owner });
    await this.token.transfer(voter3, voter3Weight, { from: owner });
    await this.token.transfer(voter4, voter4Weight, { from: owner });

    // Run proposal
    const txPropose = await this.helper.propose({ from: proposer });

    expectEvent(
      txPropose,
      'ProposalCreated',
      {
        proposalId: this.proposal.id,
        proposer,
        targets: this.proposal.targets,
        // values: this.proposal.values,
        signatures: this.proposal.signatures,
        calldatas: this.proposal.data,
        startBlock: new BN(txPropose.receipt.blockNumber).add(votingDelay),
        endBlock: new BN(txPropose.receipt.blockNumber).add(votingDelay).add(votingPeriod),
        description: this.proposal.description,
      },
    );

    await this.helper.waitForSnapshot();

    expectEvent(
      await this.helper.vote({ support: Enums.VoteType.For, reason: 'This is nice' }, { from: voter1 }),
      'VoteCast',
      {
        voter: voter1,
        support: Enums.VoteType.For,
        reason: 'This is nice',
        weight: voter1Weight,
      },
    );

    expectEvent(
      await this.helper.vote({ support: Enums.VoteType.For }, { from: voter2 }),
      'VoteCast',
      {
        voter: voter2,
        support: Enums.VoteType.For,
        weight: voter2Weight,
      },
    );

    expectEvent(
      await this.helper.vote({ support: Enums.VoteType.Against }, { from: voter3 }),
      'VoteCast',
      {
        voter: voter3,
        support: Enums.VoteType.Against,
        weight: voter3Weight,
      },
    );

    expectEvent(
      await this.helper.vote({ support: Enums.VoteType.Abstain }, { from: voter4 }),
      'VoteCast',
      {
        voter: voter4,
        support: Enums.VoteType.Abstain,
        weight: voter4Weight,
      },
    );

    await this.helper.waitForDeadline();

    const txExecute = await this.helper.execute();

    expectEvent(
      txExecute,
      'ProposalExecuted',
      { proposalId: this.proposal.id },
    );

    await expectEvent.inTransaction(
      txExecute.tx,
      this.receiver,
      'MockFunctionCalled',
    );

    // After
    expect(await this.mock.hasVoted(this.proposal.id, owner)).to.be.equal(false);
    expect(await this.mock.hasVoted(this.proposal.id, voter1)).to.be.equal(true);
    expect(await this.mock.hasVoted(this.proposal.id, voter2)).to.be.equal(true);
    expect(await this.mock.hasVoted(this.proposal.id, voter3)).to.be.equal(true);
    expect(await this.mock.hasVoted(this.proposal.id, voter4)).to.be.equal(true);
    // balances shouldn't have changed
    expect(await web3.eth.getBalance(this.mock.address)).to.be.bignumber.equal(initGovBalance);
    expect(await web3.eth.getBalance(this.receiver.address)).to.be.bignumber.equal(initReceiverBalance);
  });

  it('Voting with fractionalized parameters is properly supported', async function () {
    // fund the voters' accounts
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    await this.token.transfer(voter1, voter1Weight, { from: owner });
    await this.token.transfer(voter2, voter2Weight, { from: owner });

    await this.helper.propose({ from: proposer });
    await this.helper.waitForSnapshot();
    await this.helper.vote({ support: Enums.VoteType.Against }, { from: voter1 });
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

    const forVotes = new BN(voter2Weight).mul(new BN(70)).div(new BN(100)); // 70 percent For
    const againstVotes = new BN(voter2Weight).mul(new BN(20)).div(new BN(100)); // 20 percent Against
    const abstainVotes = new BN(voter2Weight).sub(forVotes).sub(againstVotes);

    // cast fractional votes
    const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
    const tx = await this.mock.castVoteWithReasonAndParams(this.proposal.id, 0, '', params, { from: voter2 });

    expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
    const votes = await this.mock.proposalVotes(this.proposal.id);
    expect(votes.forVotes).to.be.bignumber.equal(forVotes);
    expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(againstVotes));
    expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
  });

  it('Voting with fractionalized parameters when all votes are Abstain', async function () {
    // fund the voters' accounts
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    await this.token.transfer(voter1, voter1Weight, { from: owner });
    await this.token.transfer(voter2, voter2Weight, { from: owner });

    await this.helper.propose({ from: proposer });
    await this.helper.waitForSnapshot();
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Pending);
    await this.helper.vote({ support: Enums.VoteType.Against }, { from: voter1 });
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

    const forVotes = new BN(0);
    const againstVotes = new BN(0);
    const abstainVotes = new BN(voter2Weight);

    // cast fractional votes
    const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
    const tx = await this.mock.castVoteWithReasonAndParams(this.proposal.id, 0, '', params, { from: voter2 });

    expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
    const votes = await this.mock.proposalVotes(this.proposal.id);
    expect(votes.forVotes).to.be.bignumber.equal(forVotes);
    expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(againstVotes));
    expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
  });

  it('Voting with fractionalized parameters when all votes are For', async function () {
    // fund the voters' accounts
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    await this.token.transfer(voter1, voter1Weight, { from: owner });
    await this.token.transfer(voter2, voter2Weight, { from: owner });

    await this.helper.propose({ from: proposer });
    await this.helper.waitForSnapshot();
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Pending);
    await this.helper.vote({ support: Enums.VoteType.Against }, { from: voter1 });
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

    const forVotes = new BN(voter2Weight);
    const againstVotes = new BN(0);
    const abstainVotes = new BN(0);

    // cast fractional votes
    const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
    const tx = await this.mock.castVoteWithReasonAndParams(this.proposal.id, 0, '', params, { from: voter2 });

    expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });
    const votes = await this.mock.proposalVotes(this.proposal.id);
    expect(votes.forVotes).to.be.bignumber.equal(forVotes);
    expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(againstVotes));
    expect(votes.abstainVotes).to.be.bignumber.equal(abstainVotes);
  });

  it('Voting with fractionalized parameters, multiple voters', async function () {
    const voter1Weight = web3.utils.toWei('0.2');
    const voter2Weight = web3.utils.toWei('10.0');
    const voter3Weight = web3.utils.toWei('14.8');

    await this.token.transfer(voter1, voter1Weight, { from: owner });
    await this.token.transfer(voter2, voter2Weight, { from: owner });
    await this.token.transfer(voter3, voter3Weight, { from: owner });

    await this.helper.propose({ from: proposer });
    await this.helper.waitForSnapshot();
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Pending);
    await this.helper.vote({ support: Enums.VoteType.Against }, { from: voter1 });
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

    const voter2ForVotes = new BN(voter2Weight).mul(new BN(70)).div(new BN(100)); // 70%
    const voter2AgainstVotes = new BN(voter2Weight).mul(new BN(20)).div(new BN(100)); // 20%
    const voter2AbstainVotes = new BN(voter2Weight).sub(voter2ForVotes).sub(voter2AgainstVotes);

    const voter3ForVotes = new BN(voter3Weight).mul(new BN(15)).div(new BN(100)); // 15%
    const voter3AgainstVotes = new BN(voter3Weight).mul(new BN(80)).div(new BN(100)); // 80%
    const voter3AbstainVotes = new BN(voter3Weight).sub(voter3ForVotes).sub(voter3AgainstVotes);

    // voter 2 casts votes
    const voter2Params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [voter2ForVotes, voter2AgainstVotes]);
    const voter2Tx = await this.mock.castVoteWithReasonAndParams(this.proposal.id, 0, '', voter2Params, { from: voter2 });
    expectEvent(voter2Tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params: voter2Params });
    let votes = await this.mock.proposalVotes(this.proposal.id);
    expect(votes.forVotes).to.be.bignumber.equal(voter2ForVotes);
    expect(votes.againstVotes).to.be.bignumber.equal(new BN(voter1Weight).add(voter2AgainstVotes));
    expect(votes.abstainVotes).to.be.bignumber.equal(voter2AbstainVotes);

    // voter 2 casts votes
    const voter3Params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [voter3ForVotes, voter3AgainstVotes]);
    const voter3Tx = await this.mock.castVoteWithReasonAndParams(this.proposal.id, 0, '', voter3Params, { from: voter3 });
    expectEvent(voter3Tx, 'VoteCastWithParams', { voter: voter3, weight: voter3Weight, params: voter3Params });
    votes = await this.mock.proposalVotes(this.proposal.id);
    expect(votes.forVotes).to.be.bignumber.equal(voter3ForVotes.add(voter2ForVotes));
    expect(votes.againstVotes).to.be.bignumber.equal(
      new BN(voter1Weight).add(voter2AgainstVotes).add(voter3AgainstVotes),
    );
    expect(votes.abstainVotes).to.be.bignumber.equal(voter3AbstainVotes.add(voter2AbstainVotes));
  });

  it('Proposals approved through fractional votes can be executed', async function () {
    const voter1Weight = web3.utils.toWei('40.0');
    const voter2Weight = web3.utils.toWei('42.0');
    await this.token.transfer(voter1, voter1Weight, { from: owner });
    await this.token.transfer(voter2, voter2Weight, { from: owner });

    await this.helper.propose({ from: proposer });
    await this.helper.waitForSnapshot();
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Pending);
    await this.helper.vote({ support: Enums.VoteType.Against }, { from: voter1 });
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

    const forVotes = new BN(voter2Weight).mul(new BN(98)).div(new BN(100)); // 98%
    const againstVotes = new BN(voter2Weight).mul(new BN(1)).div(new BN(100)); // 1%

    const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
    const tx = await this.mock.castVoteWithReasonAndParams(this.proposal.id, 0, '', params, { from: voter2 });
    expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });

    // close out the voting period
    await this.helper.waitForDeadline(1); // one block after the proposal deadline
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Succeeded);

    // execute the proposal
    const executionTx = await this.helper.execute();
    expectEvent(executionTx, 'ProposalExecuted', { proposalId: this.proposal.id });
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Executed);
  });

  it('Proposals defeated through fractional votes cannot be executed', async function () {
    const voter1Weight = web3.utils.toWei('0.8');
    const voter2Weight = web3.utils.toWei('1.0');
    await this.token.transfer(voter1, voter1Weight, { from: owner });
    await this.token.transfer(voter2, voter2Weight, { from: owner });

    await this.helper.propose({ from: proposer });
    await this.helper.waitForSnapshot();
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Pending);
    await this.helper.vote({ support: Enums.VoteType.For }, { from: voter1 });
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

    const forVotes = new BN(voter2Weight).mul(new BN(1)).div(new BN(100)); // 1%
    const againstVotes = new BN(voter2Weight).mul(new BN(90)).div(new BN(100)); // 90%

    const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
    // the support type doesn't matter, specifically choosing FOR to demonstrate this
    const tx = await this.helper.vote({ support: Enums.VoteType.For, params }, { from: voter2 });
    expectEvent(tx, 'VoteCastWithParams', { voter: voter2, weight: voter2Weight, params });

    // close out the voting period
    await this.helper.waitForDeadline(1); // one block after the proposal deadline
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Defeated);

    // try to execute the proposal
    await expectRevert(this.helper.execute(), 'Governor: proposal not successful');
  });

  it('Fractional votes cannot exceed overall voter weight', async function () {
    const voter1Weight = web3.utils.toWei('5.8');
    const voter2Weight = web3.utils.toWei('1.0');
    await this.token.transfer(voter1, voter1Weight, { from: owner });
    await this.token.transfer(voter2, voter2Weight, { from: owner });

    await this.helper.propose({ from: proposer });
    await this.helper.waitForSnapshot();
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Pending);
    await this.helper.vote({ support: Enums.VoteType.For }, { from: voter1 });
    expect(await this.mock.state(this.proposal.id)).to.be.bignumber.equal(Enums.ProposalState.Active);

    const forVotes = new BN(voter2Weight).mul(new BN(56)).div(new BN(100)); // 56%
    const againstVotes = new BN(voter2Weight).mul(new BN(90)).div(new BN(100)); // 90%
    assert(forVotes.add(againstVotes).gt(new BN(voter2Weight)), 'test assumption not met');

    const params = web3.eth.abi.encodeParameters(['uint128', 'uint128'], [forVotes, againstVotes]);
    await expectRevert(
      this.helper.vote({ support: Enums.VoteType.For, params }, { from: voter2 }),
      'GovernorCountingFractional: Invalid Weight',
    );
  });

  it('Protects against fractional voting weight overflow - FOR', async function () {
    const voter1Weight = web3.utils.toWei('1.0');
    // To test for overflow, we need a number of votes greater than the max we can store.
    // Votes are stored as uint128's max uint128 == 2^128 - 1 == 3.4e38
    const voter2Weight = web3.utils.toWei('350000000000000000000'); // 3.5e38




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

});
