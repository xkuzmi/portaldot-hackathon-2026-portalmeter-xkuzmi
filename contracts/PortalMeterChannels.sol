// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PortalMeterChannels
/// @notice Unidirectional payment channels in native POT for pay-per-request APIs.
/// A payer locks POT once, then signs an EIP-712 voucher for a growing cumulative
/// amount with every request. The payee keeps only the latest voucher and redeems it
/// whenever it wants, so individual API calls cost no gas and settle in batches.
contract PortalMeterChannels {
    struct Channel {
        address payer;
        address payee;
        uint128 deposit;
        uint128 claimed;
        // 0 while the channel is open; otherwise the moment the payer may withdraw.
        uint64 closesAt;
    }

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount)");
    bytes32 public immutable DOMAIN_SEPARATOR;
    /// @notice Time the payee has to redeem after the payer asks to close.
    uint64 public immutable closeDelay;

    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public nonces;

    event ChannelOpened(bytes32 indexed channelId, address indexed payer, address indexed payee, uint256 deposit);
    event ChannelToppedUp(bytes32 indexed channelId, uint256 amount, uint256 deposit);
    event VoucherRedeemed(bytes32 indexed channelId, address indexed payee, uint256 amount, uint256 cumulativeAmount);
    event CloseRequested(bytes32 indexed channelId, uint64 closesAt);
    event ChannelReleased(bytes32 indexed channelId);
    event ChannelWithdrawn(bytes32 indexed channelId, address indexed payer, uint256 refund);

    error InvalidPayee();
    error ZeroValue();
    error UnknownChannel();
    error NotPayer();
    error NotPayee();
    error ChannelClosing();
    error ChannelNotClosable();
    error AmountExceedsDeposit();
    error NothingToRedeem();
    error InvalidSignature();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(uint64 closeDelay_) {
        closeDelay = closeDelay_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("PortalMeter"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function open(address payee) external payable returns (bytes32 channelId) {
        if (payee == address(0) || payee == msg.sender) revert InvalidPayee();
        if (msg.value == 0) revert ZeroValue();
        channelId = keccak256(abi.encode(address(this), msg.sender, payee, nonces[msg.sender]++));
        channels[channelId] = Channel(msg.sender, payee, uint128(msg.value), 0, 0);
        emit ChannelOpened(channelId, msg.sender, payee, msg.value);
    }

    function topUp(bytes32 channelId) external payable {
        Channel storage ch = _existing(channelId);
        if (msg.value == 0) revert ZeroValue();
        if (ch.closesAt != 0) revert ChannelClosing();
        ch.deposit += uint128(msg.value);
        emit ChannelToppedUp(channelId, msg.value, ch.deposit);
    }

    /// @notice Pays the payee the difference between the voucher and what was already claimed.
    function redeem(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature) external {
        Channel storage ch = _existing(channelId);
        if (msg.sender != ch.payee) revert NotPayee();
        if (ch.closesAt != 0 && block.timestamp >= ch.closesAt) revert ChannelClosing();
        if (cumulativeAmount > ch.deposit) revert AmountExceedsDeposit();
        if (cumulativeAmount <= ch.claimed) revert NothingToRedeem();
        if (_recover(voucherDigest(channelId, cumulativeAmount), signature) != ch.payer) revert InvalidSignature();

        uint256 amount = cumulativeAmount - ch.claimed;
        ch.claimed = uint128(cumulativeAmount);
        emit VoucherRedeemed(channelId, ch.payee, amount, cumulativeAmount);
        _send(ch.payee, amount);
    }

    /// @notice Starts the close timer; the payee can still redeem until it ends.
    function requestClose(bytes32 channelId) external {
        Channel storage ch = _existing(channelId);
        if (msg.sender != ch.payer) revert NotPayer();
        if (ch.closesAt != 0) revert ChannelClosing();
        ch.closesAt = uint64(block.timestamp) + closeDelay;
        emit CloseRequested(channelId, ch.closesAt);
    }

    /// @notice Lets the payee give up further claims so the payer can withdraw at once.
    function release(bytes32 channelId) external {
        Channel storage ch = _existing(channelId);
        if (msg.sender != ch.payee) revert NotPayee();
        ch.closesAt = uint64(block.timestamp);
        emit ChannelReleased(channelId);
    }

    function withdraw(bytes32 channelId) external {
        Channel storage ch = _existing(channelId);
        if (msg.sender != ch.payer) revert NotPayer();
        if (ch.closesAt == 0 || block.timestamp < ch.closesAt) revert ChannelNotClosable();
        uint256 refund = ch.deposit - ch.claimed;
        if (refund == 0) revert NothingToWithdraw();
        ch.deposit = ch.claimed;
        emit ChannelWithdrawn(channelId, ch.payer, refund);
        _send(ch.payer, refund);
    }

    function voucherDigest(bytes32 channelId, uint256 cumulativeAmount) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function remaining(bytes32 channelId) external view returns (uint256) {
        Channel storage ch = channels[channelId];
        return ch.deposit - ch.claimed;
    }

    function _existing(bytes32 channelId) private view returns (Channel storage ch) {
        ch = channels[channelId];
        if (ch.payer == address(0)) revert UnknownChannel();
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        // Reject malleable high-s signatures (EIP-2).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert InvalidSignature();
        if (v < 27) v += 27;
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
