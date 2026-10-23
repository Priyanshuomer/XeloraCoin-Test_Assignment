pragma solidity 0.4.23;

import "../zeppelin/contracts/ownership/CanReclaimToken.sol";
import "../zeppelin/contracts/ownership/Claimable.sol";
import "./Multiownable.sol";

/**
 * @title Recoverable ensures ether and ERC20 tokens can be claimed by the
 * owner of the contract.
 * @author Zachary Kilgore @ Xelora Technologies LLC
 * @dev Prevents accidental loss of tokens and ether erroneously sent to
 * this contract
 */

contract Recoverable is CanReclaimToken, Claimable, Multiownable {
  using SafeERC20 for ERC20Basic;

  // Destination is a parameter so ALL owners approve the same address (it's part of msg.data).
  function reclaimEtherTo(address _to) external onlyManyOwners {
    require(_to != address(0));
    _to.transfer(address(this).balance);
  }

  function reclaimTokenTo(ERC20Basic _token, address _to) external onlyManyOwners {
    require(_to != address(0));
    _token.safeTransfer(_to, _token.balanceOf(address(this)));
  }

  // Disable the old single-owner paths
  function reclaimToken(ERC20Basic) external { revert("Use reclaimTokenTo"); }
  function transferOwnership(address) public { revert("Ownership is multi-owner"); }
  function claimOwnership() public { revert("Ownership is multi-owner"); }
}
