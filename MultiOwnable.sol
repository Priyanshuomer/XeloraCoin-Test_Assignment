// SPDX-License-Identifier: MIT
pragma solidity 0.4.23;

import "../zeppelin/contracts/math/SafeMath.sol";

/**
 * @title Multiownable: M-of-N approval for sensitive functions.
 * @author Priyanshu Omer - Assessment Task
 * @dev A call is identified by keccak256(msg.data) (function selector + args).
 * Each owner calls the same function with the same arguments; the body runs
 * only when `required` distinct owners have confirmed.
 */
contract Multiownable {
  using SafeMath for uint256;
  
  address[] public owners;
  uint256 public required;
  mapping(address => bool) public isOwner;

  mapping(bytes32 => uint256) public confirmations;
  mapping(bytes32 => mapping(address => bool)) public hasConfirmed;

  event Confirmed(address indexed owner, bytes32 indexed operation, uint256 count, uint256 required);
  event Revoked(address indexed owner, bytes32 indexed operation);
  event Executed(bytes32 indexed operation);

  modifier onlyOwners() {
    require(isOwner[msg.sender], "Caller is not one of the owners");    // can use custom errors for versions ^0.8.4
    _;
  }

  /** Function body executes only once enough owners have confirmed. */
  modifier onlyManyOwners() {
    require(isOwner[msg.sender], "Caller is not one of the owners");
    bytes32 operation = keccak256(msg.data);

    require(!hasConfirmed[operation][msg.sender], "Already confirmed by caller");
    hasConfirmed[operation][msg.sender] = true;
    confirmations[operation] = confirmations[operation].add(1);
    emit Confirmed(msg.sender, operation, confirmations[operation], required);

    if (confirmations[operation] >= required) {
      _resetOperation(operation);   // reset BEFORE executing (re-entrancy / replay safe)
      emit Executed(operation);
      _;
    }
  }

  constructor(address[] _owners, uint256 _required) public {
    require(_owners.length > 0, "Need at least one owner");
    require(_required > 0 && _required <= _owners.length, "Invalid threshold");
    for (uint256 i = 0; i < _owners.length; i++) {
      address o = _owners[i];
      require(o != address(0), "Owner cannot be zero address");
      require(!isOwner[o], "Duplicate owner");
      isOwner[o] = true;
      owners.push(o);
    }
    required = _required;
  }

  /** An owner can withdraw their pending confirmation. */
  function revoke(bytes32 _operation) external onlyOwners {
    require(hasConfirmed[_operation][msg.sender], "Nothing to revoke");
    hasConfirmed[_operation][msg.sender] = false;
    confirmations[_operation] = confirmations[_operation].sub(1);
    emit Revoked(msg.sender, _operation);
  }

  function ownersCount() external view returns (uint256) {
    return owners.length;
  }

  function _resetOperation(bytes32 _operation) internal {
    for (uint256 i = 0; i < owners.length; i++) {
      hasConfirmed[_operation][owners[i]] = false;
    }
    confirmations[_operation] = 0;
  }
}