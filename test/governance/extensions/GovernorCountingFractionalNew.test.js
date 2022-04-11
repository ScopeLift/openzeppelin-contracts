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
    expect(await this.mock.hasVoted(this.proposal.id, owner)).to.be.equal(false);
    expect(await this.mock.hasVoted(this.proposal.id, voter1)).to.be.equal(false);
    expect(await this.mock.hasVoted(this.proposal.id, voter2)).to.be.equal(false);
    const initGovBalance = await web3.eth.getBalance(this.mock.address);
    const initReceiverBalance = await web3.eth.getBalance(this.receiver.address);

    // fund the voters' accounts
    await this.token.transfer(voter1, web3.utils.toWei('10'), { from: owner });
    await this.token.transfer(voter2, web3.utils.toWei('7'), { from: owner });
    await this.token.transfer(voter3, web3.utils.toWei('5'), { from: owner });
    await this.token.transfer(voter4, web3.utils.toWei('2'), { from: owner });

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
        weight: web3.utils.toWei('10'),
      },
    );

    expectEvent(
      await this.helper.vote({ support: Enums.VoteType.For }, { from: voter2 }),
      'VoteCast',
      {
        voter: voter2,
        support: Enums.VoteType.For,
        weight: web3.utils.toWei('7'),
      },
    );

    expectEvent(
      await this.helper.vote({ support: Enums.VoteType.Against }, { from: voter3 }),
      'VoteCast',
      {
        voter: voter3,
        support: Enums.VoteType.Against,
        weight: web3.utils.toWei('5'),
      },
    );

    expectEvent(
      await this.helper.vote({ support: Enums.VoteType.Abstain }, { from: voter4 }),
      'VoteCast',
      {
        voter: voter4,
        support: Enums.VoteType.Abstain,
        weight: web3.utils.toWei('2'),
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
    // balances shouldn't have changed
    expect(await web3.eth.getBalance(this.mock.address)).to.be.bignumber.equal(initGovBalance);
    expect(await web3.eth.getBalance(this.receiver.address)).to.be.bignumber.equal(initReceiverBalance);
  });

});
