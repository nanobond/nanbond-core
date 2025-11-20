// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/HederaTokenService.sol";
import "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/IHederaTokenService.sol";
import "@hashgraph/smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";

contract AdminV1 is Initializable, UUPSUpgradeable, OwnableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, HederaTokenService {
    /* ---------------------------
       EVENTS
       --------------------------- */
    event IssuerRegistered(address indexed issuer, address wallet);
    event KYCApproved(address indexed issuer);
    event BondCreated(uint256 indexed bondId, address indexed issuer);
    event BondApproved(uint256 indexed bondId);
    event HTSIssued(uint256 indexed bondId, bytes tokenId);
    event BondPurchased(uint256 indexed bondId, address indexed buyer, uint256 amount, uint256 hbarPaid);
    event HBARForwarded(uint256 indexed bondId, address indexed to, uint256 amount);
    event BondMatured(uint256 indexed bondId);
    event BondRedeemed(uint256 indexed bondId, address indexed investor, uint256 hbarPaid);
    event HTSBurned(uint256 indexed bondId, uint256 amount);
    event ContractUpgraded(address newImpl);
    event LegacyHTSManagerUpdated(address indexed legacy);

    /* ---------------------------
       STRUCTS & ENUMS
       --------------------------- */
    enum BondStatus { Draft, Submitted, InReview, Approved, Issued, Matured, Settled }

    struct Issuer {
        address wallet;
        bool kycApproved;
        bool connected;
    }

    struct Bond {
        uint256 id;
        address issuer;
        // params
        uint256 interestRateBP; // basis points (e.g., 500 = 5.00%)
        uint256 couponRateBP;   // basis points
        uint256 faceValue;      // in smallest HBAR unit (or a fixed USD peg if offchain)
        uint256 availableUnits; // total units available
        uint256 targetUSD;      // target in USD (optional)
        uint256 durationSec;
        uint256 maturityTimestamp;
        BondStatus status;
        bytes htsTokenId;      // HTS token id once minted
        uint256 issuedUnits;   // how many units minted/issued
    }

    /* ---------------------------
       STORAGE
       --------------------------- */
    /// @notice Legacy pointer retained for storage compatibility; no longer used after HTS merge.
    address public legacyHTSManager;
    address public treasury; // fallback receiver for HBAR forwarding failures
    uint256 public constant MIN_ISSUE_FEE = 20 * 10**8; // 20 HBAR in tinybars

    uint256 private _nextBondId;
    mapping(address => Issuer) public issuers;
    mapping(uint256 => Bond) public bonds;

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256[45] private __gap; // storage gap for future variables

    /* ---------------------------
       INITIALIZER
       --------------------------- */
    function initialize(address _legacyHTSManager, address _treasury, address _owner) public initializer {
        __Ownable_init(_owner);
        __Pausable_init();
        __ReentrancyGuard_init();
        legacyHTSManager = _legacyHTSManager;
        treasury = _treasury;
        _nextBondId = 1;
    }

    /* ---------------------------
       ISSUER / KYC
       --------------------------- */
    function registerIssuer(address wallet) external whenNotPaused {
        issuers[msg.sender].wallet = wallet;
        issuers[msg.sender].connected = true;
        emit IssuerRegistered(msg.sender, wallet);
    }

    function approveKYC(address issuer) external onlyOwner {
        issuers[issuer].kycApproved = true;
        emit KYCApproved(issuer);
    }

    function revokeKYC(address issuer) external onlyOwner {
        issuers[issuer].kycApproved = false;
    }

    /* ---------------------------
       BOND CREATION & APPROVAL
       --------------------------- */
    function createBond(
        address issuer,
        uint256 interestRateBP,
        uint256 couponRateBP,
        uint256 faceValue,
        uint256 availableUnits,
        uint256 targetUSD,
        uint256 durationSec,
        uint256 maturityTimestamp
    ) external onlyOwner returns (uint256) {
        // Admin creates bond on behalf of issuer (or accept issuer-submitted flow)
        uint256 id = _nextBondId++;
        bonds[id] = Bond({
            id: id,
            issuer: issuer,
            interestRateBP: interestRateBP,
            couponRateBP: couponRateBP,
            faceValue: faceValue,
            availableUnits: availableUnits,
            targetUSD: targetUSD,
            durationSec: durationSec,
            maturityTimestamp: maturityTimestamp,
            status: BondStatus.Submitted,
            htsTokenId: "",
            issuedUnits: 0
        });
        emit BondCreated(id, issuer);
        return id;
    }

    function approveBond(uint256 bondId) external onlyOwner {
        Bond storage b = bonds[bondId];
        require(b.status == BondStatus.Submitted || b.status == BondStatus.InReview, "invalid status");
        require(issuers[b.issuer].kycApproved, "issuer KYC required");
        b.status = BondStatus.Approved;
        emit BondApproved(bondId);
    }

    /* ---------------------------
       ISSUE / MINT HTS (issuance step)
       - Minting HTS == issuing bond
       --------------------------- */
    /// @notice Create the HTS token for the bond and mark it as issued.
    /// @param bondId the bond ID to issue
    /// @param name token name
    /// @param symbol token symbol
    /// @param metadata optional metadata bytes (used as memo, limited to 100 bytes)
    /// @param amount amount of fungible units to mint (must match available units)
    function issueBond(
        uint256 bondId,
        string calldata name,
        string calldata symbol,
        bytes calldata metadata,
        uint256 amount
    ) external payable onlyOwner whenNotPaused returns (bytes memory) {
        Bond storage b = bonds[bondId];
        require(b.status == BondStatus.Approved, "bond not approved");
        require(amount > 0, "amount=0");
        require(amount == b.availableUnits, "amount mismatch");
        require(msg.value >= MIN_ISSUE_FEE, "insufficient issue fee");

        bytes memory tokenId = _createAndMintToken(name, symbol, metadata, amount);

        b.htsTokenId = tokenId;
        b.issuedUnits = amount;
        b.status = BondStatus.Issued;

        emit HTSIssued(bondId, tokenId);
        return tokenId;
    }

    /* ---------------------------
       BUY / SALE FLOW
       - Investors send HBAR via buyBond; contract transfers HTS tokens from escrow to buyer.
       - Contract accumulates HBAR -> forward to issuer immediately or when certain condition met.
       --------------------------- */
    function buyBond(uint256 bondId, uint256 units) external payable nonReentrant whenNotPaused {
        Bond storage b = bonds[bondId];
        require(b.status == BondStatus.Issued, "bond not issued");
        require(units > 0 && units <= b.issuedUnits, "invalid units");
        // price calculation: here simple faceValue * units in HBAR units
        uint256 requiredHBAR = b.faceValue * units; // assume faceValue in wei-like HBAR smallest unit
        require(msg.value == requiredHBAR, "incorrect HBAR sent");

        // Transfer HTS from escrow (this contract) to buyer
        _transferFromTreasury(b.htsTokenId, msg.sender, units);

        // reduce issuedUnits (escrow) accordingly
        b.issuedUnits -= units;

        emit BondPurchased(bondId, msg.sender, units, msg.value);

        // Forward HBAR immediately to issuer; fallback to treasury on failure
        _forwardHBAR(bondId, issuers[b.issuer].wallet, msg.value);
    }

    function _forwardHBAR(uint256 bondId, address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        if (ok) {
            emit HBARForwarded(bondId, to, amount);
        } else {
            // attempt treasury fallback
            (bool ok2, ) = treasury.call{value: amount}("");
            require(ok2, "HBAR forward failed");
            emit HBARForwarded(bondId, treasury, amount);
        }
    }

    /* ---------------------------
       MATURITY & REDEMPTION
       - At/after maturity admin marks bond matured; investors redeem HTS for HBAR returns.
       - HTS tokens are burned when redeemed.
       --------------------------- */
    function markMature(uint256 bondId) external onlyOwner {
        Bond storage b = bonds[bondId];
        require(block.timestamp >= b.maturityTimestamp, "not matured yet");
        require(b.status == BondStatus.Issued, "invalid status");
        b.status = BondStatus.Matured;
        emit BondMatured(bondId);
    }

    /// @notice Redeem called by investor. Investor must have HTS token in their wallet; we burn tokens and pay HBAR (principal + interest).
    function redeemBond(uint256 bondId, uint256 units) external nonReentrant whenNotPaused {
        Bond storage b = bonds[bondId];
        require(b.status == BondStatus.Matured, "bond not matured");
        require(units > 0, "zero units");

        // calculate payout: principal + interest
        // interest = faceValue * units * interestRateBP / 10000
        uint256 principal = b.faceValue * units;
        uint256 interest = (principal * b.interestRateBP) / 10000;
        uint256 payout = principal + interest;

        // Atomically transfer tokens from investor to this contract and burn them
        _transferFromInvestorAndBurn(b.htsTokenId, msg.sender, units);
        emit HTSBurned(bondId, units);

        // send HBAR to investor — requires contract to have HBAR liquidity (admin should fund if necessary)
        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "HBAR payout failed");

        emit BondRedeemed(bondId, msg.sender, payout);
    }

    /* ---------------------------
       ADMIN UTILITIES
       --------------------------- */
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Emergency withdraw (HBAR) — owner can withdraw to specified address
    function emergencyWithdrawHBAR(address to) external onlyOwner {
        uint256 bal = address(this).balance;
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "withdraw failed");
    }

    /// @dev Legacy setter retained for compatibility — stores the address for reference only.
    function setHTSManager(address _m) external onlyOwner {
        legacyHTSManager = _m;
        emit LegacyHTSManagerUpdated(_m);
    }

    function setTreasury(address _t) external onlyOwner {
        treasury = _t;
    }

    /* ---------------------------
       UUPS / UPGRADE HOOK
       --------------------------- */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        emit ContractUpgraded(newImplementation);
    }

    // allow contract to receive HBAR (for payouts or other flows)
    receive() external payable {}
    fallback() external payable {}

    /* ---------------------------
       HTS HELPERS
       --------------------------- */

    function _transferFromTreasury(bytes memory tokenId, address to, uint256 amount) internal {
        address token = _decodeTokenAddress(tokenId);
        require(token != address(0), "token=0");
        require(to != address(0), "to=0");
        require(amount > 0, "amt=0");

        int resp = transferToken(token, address(this), to, _int64Safe(amount));
        require(resp == HederaResponseCodes.SUCCESS, "HTS transfer failed");
    }

    function _transferFromInvestorAndBurn(bytes memory tokenId, address from, uint256 amount) internal {
        address token = _decodeTokenAddress(tokenId);
        require(token != address(0), "token=0");
        require(from != address(0), "from=0");
        require(amount > 0, "amt=0");

        int transferResp = transferToken(token, from, address(this), _int64Safe(amount));
        require(transferResp == HederaResponseCodes.SUCCESS, "HTS transfer failed");

        int64[] memory serials = new int64[](0);
        (int burnResp,) = burnToken(token, _int64Safe(amount), serials);
        require(burnResp == HederaResponseCodes.SUCCESS, "HTS burn failed");
    }

    function _decodeTokenAddress(bytes memory tokenId) internal pure returns (address token) {
        token = abi.decode(tokenId, (address));
    }

    function _createAndMintToken(
        string memory name,
        string memory symbol,
        bytes memory metadata,
        uint256 amount
    ) internal returns (bytes memory tokenId) {
        require(bytes(name).length > 0, "name required");
        require(bytes(symbol).length > 0, "symbol required");

        // Build token struct
        IHederaTokenService.HederaToken memory token;
        token.name = name;
        token.symbol = symbol;
        token.treasury = address(this);
        token.tokenSupplyType = false; // infinite supply
        token.maxSupply = 0;
        token.freezeDefault = false;
        token.tokenKeys = new IHederaTokenService.TokenKey[](0);

        // Metadata -> memo (max 100 bytes)
        if (metadata.length > 0) {
            uint256 memoLength = metadata.length > 100 ? 100 : metadata.length;
            bytes memory memoBytes = new bytes(memoLength);
            for (uint256 i = 0; i < memoLength; i++) {
                memoBytes[i] = metadata[i];
            }
            token.memo = string(memoBytes);
        } else {
            token.memo = "";
        }

        // Expiry ~1 year with auto-renew handled by contract
        uint256 expirySeconds = block.timestamp + 365 days;
        if (expirySeconds > uint256(uint64(type(int64).max))) {
            expirySeconds = uint256(uint64(type(int64).max));
        }
        IHederaTokenService.Expiry memory expiry = IHederaTokenService.Expiry({
            second: int64(int256(expirySeconds)),
            autoRenewPeriod: int64(7890000),
            autoRenewAccount: address(this)
        });
        token.expiry = expiry;

        (int responseCode, address createdToken) = HederaTokenService.createFungibleToken(
            token,
            _int64Safe(amount),
            0
        );
        require(responseCode == HederaResponseCodes.SUCCESS, "HTS create failed");

        tokenId = abi.encode(createdToken);
    }

    function _int64Safe(uint256 v) internal pure returns (int64) {
        require(v <= uint256(uint64(type(int64).max)), "overflow int64");
        return int64(int256(v));
    }
}