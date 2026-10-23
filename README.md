# XeloraCoin (FXC): Multiownable Security Upgrade

## Task

> - Modify the existing functions that currently use `onlyOwner` so they use a `Multiownable` pattern.
> - Explain the rationale and approach for strengthening security protections.

This repository contains the XeloraCoin (FXC) ERC20 token suite (Solidity 0.4.23, OpenZeppelin 1.x). Every privileged function that was previously guarded by a single `onlyOwner` key is now guarded by an **M-of-N multi-owner approval** (`onlyManyOwners`).

---

## 1. Rationale: why change `onlyOwner`?

In the original design a single externally owned account (EOA) controls:

| Capability | Contract | Impact if the key is compromised |
|---|---|---|
| `pause()` / `unpause()` | XeloraCoin (PausableToken) | Freeze or unfreeze all token transfers |
| `setUpgradeAgent()` | UpgradeableToken | Point holders at a malicious upgrade contract |
| `reclaimToken()` / `reclaimEther()` | Recoverable | Drain tokens and ether held by the token or vault |
| `setAllocation()`, `lock()`, `unlock()`, `transferFor()` | TokenVault | Misallocate, lock, or release vested tokens |
| `transferOwnership()` / `claimOwnership()` | Claimable | Hand every power above to an attacker |

That is a **single point of failure**. A leaked private key, a phished signer, a malicious insider, or a lost key each leads to loss of funds or loss of control. Because the owner can also reclaim tokens from the vault, vesting guarantees to beneficiaries are only as strong as one key.

## 2. Approach: M-of-N confirmation

`contracts/Multiownable.sol` provides:

- A fixed set of **N owners** and a threshold **M (`required`)**, validated in the constructor (at least one owner, `1 <= M <= N`, no zero address, no duplicates).
- A modifier, `onlyManyOwners`, that records a vote and runs the function body **only when the M-th distinct owner confirms**.
- Each pending operation is identified by `keccak256(msg.data)`, i.e. the function selector **plus its exact arguments**. Owners are therefore approving a specific action, not just a function name.
- `revoke(bytes32 operation)` lets an owner withdraw a pending vote.
- Events (`Confirmed`, `Revoked`, `Executed`) give an on-chain audit trail.

### How a call flows (example: 2-of-3 `unlock()`)

1. Owner A calls `unlock()`. The vote is recorded (`Confirmed 1/2`). The body does **not** run.
2. Owner B calls `unlock()`. The vote count reaches 2, state is reset, `Executed` is emitted, and the body runs (the vault unlocks).
3. If A tries to vote twice, it reverts (`Already confirmed by caller`).

## 3. What changed

| File | Function(s) | Change |
|---|---|---|
| `Multiownable.sol` | (new) | M-of-N approval contract, uses SafeMath |
| `Recoverable.sol` | `reclaimEther` | Replaced by `reclaimEtherTo(address)` under `onlyManyOwners` |
| `Recoverable.sol` | `reclaimToken` | Old path disabled. New `reclaimTokenTo(token, to)` under `onlyManyOwners` |
| `Recoverable.sol` | `transferOwnership`, `claimOwnership` | Disabled (revert), since control now lives in the owner set |
| `UpgradeableToken.sol` | `setUpgradeAgent` | `onlyOwner` replaced with `onlyManyOwners` |
| `TokenVault.sol` | `setAllocation`, `lock`, `unlock`, `transferFor` | `onlyOwner` replaced with `onlyManyOwners` |
| `XeloraCoin.sol` | `pause`, `unpause` | Overridden with `onlyManyOwners` |
| `Migrations.sol` | `restricted` | Intentionally unchanged (Truffle deployment helper, no token authority) |

Constructors of `XeloraCoin` and `TokenVault` now take `address[] _owners, uint256 _required`.

## 4. Security properties

- **No single key can act alone.** Compromising fewer than M keys is not enough.
- **Arguments are part of the approval.** Votes for `reclaimTokenTo(X, alice)` cannot be reused for `reclaimTokenTo(X, mallory)`.
- **No double voting.** One vote per owner per operation.
- **Replay and re-entrancy safe.** Vote state is reset **before** the protected body executes, so an operation cannot be re-triggered by a stale tally or by re-entry.
- **Fail early.** Validation modifiers (`vaultLocked`, `vestingPassed`, etc.) are listed **before** `onlyManyOwners`, so invalid calls revert on the first vote instead of wasting confirmations.
- **Closed bypasses.** Inherited single-owner paths (`pause`, `unpause`, `reclaimToken`, `transferOwnership`, `claimOwnership`) were overridden. Otherwise the multisig could be bypassed by one key.
- **Destination is explicit.** Reclaim functions take a recipient parameter so that all owners approve the same destination (it is part of `msg.data`).
- **Transparency.** Events let off-chain monitors alert on pending and executed operations.

## 5. Design decisions

1. **Hashing `msg.data`**: simple, gas-cheap, and binds approval to exact arguments.
2. **Reset before execute**: follows checks-effects-interactions.
3. **Silent non-execution until threshold**: the transaction succeeds but the body is skipped. Clients must read the `Executed` event and **not** rely on return values (for example `setAllocation` returns `false` until the final vote).
4. **Owners fixed at deployment**: keeps the attack surface small. See future work for rotation.

## 6. Usage

Deploy with three owners and a threshold of 2:

```js
const owners = [accounts[0], accounts[1], accounts[2]];
const token = await XeloraCoin.new(owners, 2);

// Pause requires two distinct owners sending the identical call
await token.pause({ from: accounts[0] });   // Confirmed 1/2, nothing happens yet
await token.pause({ from: accounts[1] });   // Confirmed 2/2, Executed, token paused
```

For `TokenVault`:

```js
const vault = await TokenVault.new(token.address, tokensToBeAllocated, vestingPeriod, owners, 2);
await vault.setAllocation(investor, amount, { from: accounts[0] });
await vault.setAllocation(investor, amount, { from: accounts[1] }); // executed
```

Owners must send **identical arguments**, otherwise they are voting on different operations.

## 7. Testing

```
truffle test
```

Cases covered or recommended:

1. A non-owner call to any converted function reverts.
2. With 2-of-3, the first confirmation does not execute and the second does.
3. The same owner confirming twice reverts.
4. `revoke` lowers the count, and a revoked vote does not count.
5. Different arguments or selectors never share votes.
6. An operation can be repeated after execution (the counter resets).
7. `pause`, `unpause`, `reclaimToken`, `transferOwnership` and `claimOwnership` cannot be used by a single key.
8. Constructor rejects empty owner list, zero address, duplicates, and invalid thresholds.

## 8. Limitations and trade-offs

- **Emergency response is slower.** `pause` needs M signers online. Consider a lower threshold or a dedicated guardian role for pause only.
- **`setAllocation` needs M transactions per beneficiary.** For many beneficiaries, add a batch `setAllocations(address[], uint256[])` under `onlyManyOwners`.
- **Pending votes never expire.** Stale votes could be completed later. A time-to-live would address this.
- **No owner rotation or threshold change.** Add `addOwner`, `removeOwner` and `changeRequired` as multi-approved operations.
- **The legacy `owner` storage variable** from `Ownable` still exists but no longer grants authority, since all privileged paths use `onlyManyOwners`.
- **Gas grows with N**, because `_resetOperation` loops over owners. Keep N small (typically 3 to 7).
- **Owner keys still matter.** Use hardware wallets and keep signers independent (different people, devices, locations).

## 9. Gas efficiency: custom errors (Solidity ^0.8.4)

The current code targets Solidity 0.4.23, which only supports `require(condition, "string")`. If the project is migrated to **Solidity ^0.8.4**, replace revert strings with **custom errors**:

- **Cheaper deployment:** revert strings are stored in the contract bytecode. Custom errors are identified by a 4-byte selector, so bytecode is smaller.
- **Cheaper reverts at runtime:** a string revert ABI-encodes `Error(string)` (selector, offset, length, padded text). A custom error returns only the 4-byte selector plus any typed arguments.
- **Richer debugging:** errors can carry parameters (for example, the caller or the operation hash) without string concatenation.

Example for `Multiownable`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

contract Multiownable {
  error NotOwner(address caller);
  error AlreadyConfirmed(address caller, bytes32 operation);
  error NothingToRevoke(address caller, bytes32 operation);
  error InvalidThreshold(uint256 required, uint256 ownersCount);
  error ZeroAddressOwner();
  error DuplicateOwner(address owner);
  error NoOwners();

  modifier onlyOwners() {
    if (!isOwner[msg.sender]) revert NotOwner(msg.sender);
    _;
  }

  modifier onlyManyOwners() {
    if (!isOwner[msg.sender]) revert NotOwner(msg.sender);
    bytes32 operation = keccak256(msg.data);

    if (hasConfirmed[operation][msg.sender]) revert AlreadyConfirmed(msg.sender, operation);
    hasConfirmed[operation][msg.sender] = true;
    unchecked { confirmations[operation] += 1; } // cannot overflow: bounded by owners.length

    emit Confirmed(msg.sender, operation, confirmations[operation], required);

    if (confirmations[operation] >= required) {
      _resetOperation(operation); // reset BEFORE executing
      emit Executed(operation);
      _;
    }
  }
}
```

Notes:

- Use `if (!cond) revert CustomError(...)`, which works from 0.8.4. The `require(cond, CustomError())` form needs a much newer compiler (0.8.26 and later), so the `if/revert` form is the portable choice.
- Apply the same pattern to the other contracts (for example `VaultNotLocked()`, `VestingNotOver()`, `AllocationAlreadySet(address)`, `TokenPaused()`).
- Solidity 0.8 has built-in overflow checks, so `SafeMath` is no longer needed. This saves further gas and removes an import.
- Off-chain tooling (ethers, viem, Hardhat, Foundry) decodes custom errors from the ABI, so tests should assert on the error name (for example `revertedWithCustomError(vault, "NotOwner")`) instead of message strings.
- Cache storage reads in local variables inside the modifier (for example `confirmations[operation]`) to avoid repeated `SLOAD`s.

## 10. Future work

- Owner management and threshold changes via multi-approval.
- Expiring confirmations.
- Batch allocation.
- Replace the custom module with an audited **Gnosis Safe** as the single owner for production, and get an independent audit.
- Migrate to Solidity ^0.8.x (custom errors, built-in overflow checks) when the upgrade path allows.

## 11. Project structure

```
contracts/
  Multiownable.sol        (new)
  Recoverable.sol         (modified)
  UpgradeableToken.sol    (modified)
  TokenVault.sol          (modified)
  XeloraCoin.sol          (modified)
  Migrations.sol
  tokenmarket/UpgradeAgent.sol
test/
  Multiownable.test.js
```

<!-- # https://drive.google.com/file/d/1PQxphMW2GMXgjiUPTp49OxlZ1VqVyK0X/view -->