/**
 * Truffle tests for the Multiownable (M-of-N) security upgrade.
 *
 * Assumes the contracts were modified as described in the README:
 *   - Multiownable uses SafeMath (`using SafeMath for uint256;`)
 *   - XeloraCoin(address[] owners, uint256 required)
 *   - TokenVault(token, tokensToBeAllocated, vestingPeriod, address[] owners, uint256 required)
 *   - Recoverable exposes reclaimTokenTo / reclaimEtherTo (with a validRecipient
 *     modifier placed BEFORE onlyManyOwners) and disables the legacy
 *     single-owner paths
 *   - UpgradeableToken.setUpgradeAgent validates through a modifier placed
 *     BEFORE onlyManyOwners
 *   - XeloraCoin.pause / unpause list whenNotPaused / whenPaused BEFORE onlyManyOwners
 *   - Test helpers exist: contracts/mocks/MockUpgradeAgent.sol, contracts/mocks/ForceSend.sol
 *
 * Needs a local chain with at least 9 accounts (Ganache default is 10).
 * Run with: truffle test
 */

const XeloraCoin = artifacts.require("XeloraCoin");
const TokenVault = artifacts.require("TokenVault");
const MockUpgradeAgent = artifacts.require("MockUpgradeAgent");
const ForceSend = artifacts.require("ForceSend");

const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 24 * 60 * 60;

/* ------------------------------ helpers ------------------------------ */

async function assertRevert(promise, message) {
  try {
    await promise;
  } catch (error) {
    const msg = error.message || "";
    const ok = msg.indexOf("revert") >= 0 || msg.indexOf("invalid opcode") >= 0;
    assert(ok, "Expected a revert, got: " + msg);
    return;
  }
  assert.fail(message || "Expected revert not received");
}

function findLog(result, eventName) {
  return result.logs.find(function (l) {
    return l.event === eventName;
  });
}

// Works with both web3 0.20 (sendAsync) and web3 1.x (send) providers.
function rpc(method, params) {
  return new Promise(function (resolve, reject) {
    const provider = web3.currentProvider;
    const send = (provider.sendAsync || provider.send).bind(provider);
    send(
      { jsonrpc: "2.0", method: method, params: params || [], id: Date.now() },
      function (err, res) {
        return err ? reject(err) : resolve(res);
      }
    );
  });
}

async function increaseTime(seconds) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}

// Number() works for both BigNumber (web3 0.20) and BN (web3 1.x).
const num = function (x) {
  return Number(x);
};

// `await` works on both the synchronous (web3 0.20) and promise (web3 1.x) forms.
async function etherBalance(address) {
  return num(await web3.eth.getBalance(address));
}

/* ------------------------------- tests ------------------------------- */

contract("Multiownable", function (accounts) {
  const owner1 = accounts[0];
  const owner2 = accounts[1];
  const owner3 = accounts[2];
  const outsider = accounts[5];
  const owners = [owner1, owner2, owner3];
  const required = 2;

  /* ---------------------- constructor validation ---------------------- */

  describe("constructor validation", function () {
    it("sets owners and threshold", async function () {
      const token = await XeloraCoin.new(owners, required);
      assert.equal(num(await token.required()), required);
      assert.equal(num(await token.ownersCount()), 3);
      assert.equal(await token.isOwner(owner1), true);
      assert.equal(await token.isOwner(owner2), true);
      assert.equal(await token.isOwner(owner3), true);
      assert.equal(await token.isOwner(outsider), false);
    });

    it("rejects an empty owner list", async function () {
      await assertRevert(XeloraCoin.new([], 1));
    });

    it("rejects a threshold of zero", async function () {
      await assertRevert(XeloraCoin.new(owners, 0));
    });

    it("rejects a threshold greater than the number of owners", async function () {
      await assertRevert(XeloraCoin.new(owners, 4));
    });

    it("rejects the zero address as an owner", async function () {
      await assertRevert(XeloraCoin.new([owner1, ZERO], 1));
    });

    it("rejects duplicate owners", async function () {
      await assertRevert(XeloraCoin.new([owner1, owner1], 1));
    });
  });

  /* ------------------ core M-of-N behaviour (pause) ------------------ */

  describe("M-of-N confirmation (pause / unpause)", function () {
    let token;

    beforeEach(async function () {
      token = await XeloraCoin.new(owners, required);
    });

    it("reverts when a non-owner calls pause", async function () {
      await assertRevert(token.pause({ from: outsider }));
    });

    it("reverts when a non-owner calls unpause", async function () {
      await token.pause({ from: owner1 });
      await token.pause({ from: owner2 });
      assert.equal(await token.paused(), true);

      await assertRevert(token.unpause({ from: outsider }));
      assert.equal(await token.paused(), true);
    });

    it("does not execute on the first confirmation", async function () {
      const res = await token.pause({ from: owner1 });
      assert.equal(await token.paused(), false);

      const confirmed = findLog(res, "Confirmed");
      assert.ok(confirmed, "Confirmed event expected");
      assert.equal(confirmed.args.owner, owner1);
      assert.equal(num(confirmed.args.count), 1);
      assert.equal(num(confirmed.args.required), required);
      assert.notOk(findLog(res, "Executed"), "Must not execute yet");
    });

    it("executes on the M-th distinct confirmation", async function () {
      await token.pause({ from: owner1 });
      const res = await token.pause({ from: owner2 });

      assert.equal(await token.paused(), true);
      assert.ok(findLog(res, "Executed"), "Executed event expected");
    });

    it("reverts when the same owner confirms twice", async function () {
      await token.pause({ from: owner1 });
      await assertRevert(token.pause({ from: owner1 }));
      assert.equal(await token.paused(), false);
    });

    it("resets the counter after execution so the operation can be repeated", async function () {
      // pause (2 votes)
      await token.pause({ from: owner1 });
      await token.pause({ from: owner2 });
      assert.equal(await token.paused(), true);

      // unpause (2 votes)
      await token.unpause({ from: owner1 });
      await token.unpause({ from: owner3 });
      assert.equal(await token.paused(), false);

      // pause again needs a fresh set of 2 votes: one vote must not be enough
      await token.pause({ from: owner1 });
      assert.equal(await token.paused(), false);
      await token.pause({ from: owner3 });
      assert.equal(await token.paused(), true);
    });

    it("pause reverts on the FIRST vote when already paused (fail early)", async function () {
      const res = await token.pause({ from: owner1 });
      const operation = findLog(res, "Confirmed").args.operation;
      await token.pause({ from: owner2 });
      assert.equal(await token.paused(), true);

      await assertRevert(token.pause({ from: owner3 }));
      assert.equal(num(await token.confirmations(operation)), 0, "no vote must be stored");
    });

    it("unpause reverts on the FIRST vote when not paused (fail early)", async function () {
      await assertRevert(token.unpause({ from: owner1 }));
    });

    it("different function selectors never share votes", async function () {
      const r1 = await token.pause({ from: owner1 });
      const r2 = await token.reclaimTokenTo(token.address, accounts[6], { from: owner2 });

      const op1 = findLog(r1, "Confirmed").args.operation;
      const op2 = findLog(r2, "Confirmed").args.operation;
      assert.notEqual(op1, op2);

      assert.equal(await token.paused(), false);
      assert.equal(num(await token.confirmations(op1)), 1);
      assert.equal(num(await token.confirmations(op2)), 1);
    });
  });

  /* ----------------------------- revoke ------------------------------ */

  describe("revoke", function () {
    let token;
    let operation;

    beforeEach(async function () {
      token = await XeloraCoin.new(owners, required);
      const res = await token.pause({ from: owner1 });
      operation = findLog(res, "Confirmed").args.operation;
    });

    it("lets an owner withdraw a pending vote", async function () {
      assert.equal(num(await token.confirmations(operation)), 1);

      const res = await token.revoke(operation, { from: owner1 });
      assert.ok(findLog(res, "Revoked"), "Revoked event expected");
      assert.equal(num(await token.confirmations(operation)), 0);
      assert.equal(await token.hasConfirmed(operation, owner1), false);
    });

    it("does not count a revoked vote towards the threshold", async function () {
      await token.revoke(operation, { from: owner1 });

      // owner2 votes: only 1 live confirmation -> must NOT execute
      await token.pause({ from: owner2 });
      assert.equal(await token.paused(), false);

      // owner3 votes: now 2 live confirmations -> executes
      await token.pause({ from: owner3 });
      assert.equal(await token.paused(), true);
    });

    it("lets a revoked owner vote again", async function () {
      await token.revoke(operation, { from: owner1 });
      await token.pause({ from: owner1 });
      assert.equal(num(await token.confirmations(operation)), 1);
    });

    it("reverts when there is nothing to revoke", async function () {
      await assertRevert(token.revoke(operation, { from: owner2 }));
    });

    it("reverts when a non-owner tries to revoke", async function () {
      await assertRevert(token.revoke(operation, { from: outsider }));
    });
  });

  /* ------------- bypass paths closed + recovery functions ------------- */

  describe("single-key bypass paths and recovery functions", function () {
    let token;

    beforeEach(async function () {
      token = await XeloraCoin.new(owners, required);
    });

    it("transferOwnership reverts", async function () {
      await assertRevert(token.transferOwnership(outsider, { from: owner1 }));
    });

    it("claimOwnership reverts", async function () {
      await assertRevert(token.claimOwnership({ from: outsider }));
    });

    it("legacy reclaimToken reverts", async function () {
      await assertRevert(token.reclaimToken(token.address, { from: owner1 }));
    });

    it("a non-owner cannot call reclaimTokenTo", async function () {
      await assertRevert(
        token.reclaimTokenTo(token.address, outsider, { from: outsider })
      );
    });

    it("a non-owner cannot call reclaimEtherTo", async function () {
      await assertRevert(token.reclaimEtherTo(outsider, { from: outsider }));
    });

    it("reclaimTokenTo rejects the zero address on the FIRST vote", async function () {
      await assertRevert(token.reclaimTokenTo(token.address, ZERO, { from: owner1 }));
    });

    it("reclaimEtherTo rejects the zero address on the FIRST vote", async function () {
      await assertRevert(token.reclaimEtherTo(ZERO, { from: owner1 }));
    });

    it("reclaimTokenTo needs M confirmations and sends to the approved destination", async function () {
      const stuck = 100;
      const destination = accounts[6];

      // Tokens mistakenly sent to the token contract itself
      await token.transfer(token.address, stuck, { from: owner1 });
      assert.equal(num(await token.balanceOf(token.address)), stuck);

      await token.reclaimTokenTo(token.address, destination, { from: owner1 });
      assert.equal(num(await token.balanceOf(destination)), 0, "1 vote must not move funds");

      await token.reclaimTokenTo(token.address, destination, { from: owner2 });
      assert.equal(num(await token.balanceOf(destination)), stuck);
      assert.equal(num(await token.balanceOf(token.address)), 0);
    });

    it("votes for different destinations are separate operations", async function () {
      const stuck = 100;
      await token.transfer(token.address, stuck, { from: owner1 });

      await token.reclaimTokenTo(token.address, accounts[6], { from: owner1 });
      await token.reclaimTokenTo(token.address, accounts[7], { from: owner2 });

      // Neither destination reached the threshold
      assert.equal(num(await token.balanceOf(accounts[6])), 0);
      assert.equal(num(await token.balanceOf(accounts[7])), 0);
      assert.equal(num(await token.balanceOf(token.address)), stuck);
    });

    it("reclaimEtherTo needs M confirmations and empties the contract", async function () {
      const wei = 1000;
      const destination = accounts[6];

      // The token has no payable fallback, so force-send ether with selfdestruct
      const sender = await ForceSend.new({ from: owner1, value: wei });
      await sender.destroy(token.address, { from: owner1 });
      assert.equal(await etherBalance(token.address), wei);

      await token.reclaimEtherTo(destination, { from: owner1 });
      assert.equal(await etherBalance(token.address), wei, "1 vote must not move ether");

      await token.reclaimEtherTo(destination, { from: owner2 });
      assert.equal(await etherBalance(token.address), 0);
    });
  });

  /* ------------------------ setUpgradeAgent -------------------------- */

  describe("setUpgradeAgent", function () {
    let token;
    let agent;

    beforeEach(async function () {
      token = await XeloraCoin.new(owners, required);
      const supply = await token.totalSupply();
      agent = await MockUpgradeAgent.new(supply);
    });

    it("reverts for a non-owner", async function () {
      await assertRevert(token.setUpgradeAgent(agent.address, { from: outsider }));
    });

    it("needs M confirmations and then sets the agent", async function () {
      assert.equal(num(await token.getUpgradeState()), 2, "WaitingForAgent expected");

      await token.setUpgradeAgent(agent.address, { from: owner1 });
      assert.equal(await token.upgradeAgent(), ZERO, "1 vote must not set the agent");

      const res = await token.setUpgradeAgent(agent.address, { from: owner2 });
      assert.equal(await token.upgradeAgent(), agent.address);
      assert.ok(findLog(res, "UpgradeAgentSet"), "UpgradeAgentSet event expected");
      assert.equal(num(await token.getUpgradeState()), 3, "ReadyToUpgrade expected");
    });

    it("rejects the zero address on the FIRST vote", async function () {
      await assertRevert(token.setUpgradeAgent(ZERO, { from: owner1 }));
    });

    it("rejects an agent whose supply does not match on the FIRST vote", async function () {
      const badAgent = await MockUpgradeAgent.new(1);
      await assertRevert(token.setUpgradeAgent(badAgent.address, { from: owner1 }));
    });

    it("rejects setting an agent while the token is paused, on the FIRST vote", async function () {
      await token.pause({ from: owner1 });
      await token.pause({ from: owner2 });
      assert.equal(await token.paused(), true);

      await assertRevert(token.setUpgradeAgent(agent.address, { from: owner1 }));
    });
  });

  /* ---------------------------- TokenVault ---------------------------- */

  describe("TokenVault", function () {
    const total = 1000;
    const investor1 = accounts[3];
    const investor2 = accounts[4];
    const amount1 = 600;
    const amount2 = 400;

    let token;
    let vault;

    // Two distinct owners send the same call
    async function approve(fnName, args) {
      await vault[fnName].apply(vault, args.concat([{ from: owner1 }]));
      await vault[fnName].apply(vault, args.concat([{ from: owner2 }]));
    }

    async function loadAndLock() {
      await approve("setAllocation", [investor1, amount1]);
      await approve("setAllocation", [investor2, amount2]);
      await approve("lock", []);
    }

    async function deploy(vestingPeriod) {
      token = await XeloraCoin.new(owners, required);
      vault = await TokenVault.new(
        token.address,
        total,
        vestingPeriod,
        owners,
        required
      );
      // Fund the vault (deployer received the whole supply)
      await token.transfer(vault.address, total, { from: owner1 });
    }

    describe("allocation and locking", function () {
      beforeEach(async function () {
        await deploy(0);
      });

      it("setAllocation needs two confirmations", async function () {
        await vault.setAllocation(investor1, amount1, { from: owner1 });
        assert.equal(num(await vault.allocations(investor1)), 0);

        const res = await vault.setAllocation(investor1, amount1, { from: owner2 });
        assert.ok(findLog(res, "Allocated"), "Allocated event expected");
        assert.equal(num(await vault.allocations(investor1)), amount1);
        assert.equal(num(await vault.tokensAllocated()), amount1);
      });

      it("setAllocation reverts for a non-owner", async function () {
        await assertRevert(
          vault.setAllocation(investor1, amount1, { from: outsider })
        );
      });

      it("setAllocation rejects the zero address on the FIRST vote", async function () {
        await assertRevert(vault.setAllocation(ZERO, amount1, { from: owner1 }));
      });

      it("setAllocation rejects a zero amount on the FIRST vote", async function () {
        await assertRevert(vault.setAllocation(investor1, 0, { from: owner1 }));
      });

      it("setAllocation rejects a second allocation for the same beneficiary on the FIRST vote", async function () {
        await approve("setAllocation", [investor1, amount1]);
        await assertRevert(vault.setAllocation(investor1, 1, { from: owner3 }));
      });

      it("votes with different arguments do not share confirmations", async function () {
        await vault.setAllocation(investor1, amount1, { from: owner1 });
        await vault.setAllocation(investor1, amount1 - 100, { from: owner2 });

        assert.equal(num(await vault.allocations(investor1)), 0);

        // owner3 matches owner1's exact arguments -> executes with the original amount
        await vault.setAllocation(investor1, amount1, { from: owner3 });
        assert.equal(num(await vault.allocations(investor1)), amount1);
      });

      it("lock reverts for a non-owner", async function () {
        await approve("setAllocation", [investor1, amount1]);
        await approve("setAllocation", [investor2, amount2]);
        await assertRevert(vault.lock({ from: outsider }));
      });

      it("lock needs two confirmations", async function () {
        await approve("setAllocation", [investor1, amount1]);
        await approve("setAllocation", [investor2, amount2]);

        await vault.lock({ from: owner1 });
        assert.equal(num(await vault.lockedAt()), 0);

        const res = await vault.lock({ from: owner2 });
        assert.isAbove(num(await vault.lockedAt()), 0);
        assert.ok(findLog(res, "Locked"), "Locked event expected");
        assert.ok(findLog(res, "Executed"), "Executed event expected");
      });

      it("lock reverts on the FIRST vote if allocations are incomplete", async function () {
        await approve("setAllocation", [investor1, amount1]); // 600 of 1000
        await assertRevert(vault.lock({ from: owner1 }));
      });

      it("lock reverts on the FIRST vote if the vault is not funded", async function () {
        const unfunded = await TokenVault.new(token.address, total, 0, owners, required);
        await unfunded.setAllocation(investor1, total, { from: owner1 });
        await unfunded.setAllocation(investor1, total, { from: owner2 });

        await assertRevert(unfunded.lock({ from: owner1 }));
      });

      it("rejects further allocations once locked, on the FIRST vote", async function () {
        await loadAndLock();
        await assertRevert(
          vault.setAllocation(accounts[8], 1, { from: owner1 })
        );
      });

      it("unlock reverts on the FIRST vote before the vault is locked", async function () {
        await assertRevert(vault.unlock({ from: owner1 }));
      });
    });

    describe("unlock and claim (no vesting period)", function () {
      beforeEach(async function () {
        await deploy(0);
        await loadAndLock();
      });

      it("unlock reverts for a non-owner", async function () {
        await assertRevert(vault.unlock({ from: outsider }));
      });

      it("unlock needs two confirmations", async function () {
        await vault.unlock({ from: owner1 });
        assert.equal(num(await vault.unlockedAt()), 0);

        await vault.unlock({ from: owner3 });
        assert.isAbove(num(await vault.unlockedAt()), 0);
      });

      it("unlock reverts on the FIRST vote once already unlocked", async function () {
        await approve("unlock", []);
        await assertRevert(vault.unlock({ from: owner1 }));
      });

      it("claim reverts while the vault is still locked", async function () {
        await assertRevert(vault.claim({ from: investor1 }));
      });

      it("beneficiaries can claim after unlock", async function () {
        await approve("unlock", []);

        await vault.claim({ from: investor1 });
        assert.equal(num(await token.balanceOf(investor1)), amount1);
        assert.equal(num(await vault.totalClaimed()), amount1);

        // double claim is impossible
        await assertRevert(vault.claim({ from: investor1 }));
      });

      it("an account without an allocation cannot claim", async function () {
        await approve("unlock", []);
        await assertRevert(vault.claim({ from: outsider }));
      });

      it("transferFor needs two confirmations", async function () {
        await approve("unlock", []);

        await vault.transferFor(investor2, { from: owner1 });
        assert.equal(num(await token.balanceOf(investor2)), 0);

        await vault.transferFor(investor2, { from: owner2 });
        assert.equal(num(await token.balanceOf(investor2)), amount2);
      });

      it("transferFor reverts for a non-owner", async function () {
        await approve("unlock", []);
        await assertRevert(vault.transferFor(investor2, { from: outsider }));
      });

      it("transferFor reverts on the FIRST vote when there is nothing to claim", async function () {
        await approve("unlock", []);

        // never allocated
        await assertRevert(vault.transferFor(outsider, { from: owner1 }));

        // already claimed
        await vault.claim({ from: investor1 });
        await assertRevert(vault.transferFor(investor1, { from: owner1 }));
      });

      it("transferFor reverts on the FIRST vote while the vault is locked", async function () {
        const locked = await TokenVault.new(token.address, total, 0, owners, required);
        await assertRevert(locked.transferFor(investor1, { from: owner1 }));
      });
    });

    describe("vesting period", function () {
      beforeEach(async function () {
        await deploy(DAY);
        await loadAndLock();
      });

      it("unlock reverts on the FIRST vote while the lock-up is running", async function () {
        await assertRevert(vault.unlock({ from: owner1 }));
        assert.equal(num(await vault.unlockedAt()), 0);
      });

      it("unlock works once the vesting period has passed", async function () {
        await increaseTime(DAY + 60);
        await approve("unlock", []);
        assert.isAbove(num(await vault.unlockedAt()), 0);
      });
    });
  });
});