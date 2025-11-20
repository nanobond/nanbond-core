# Contract ABIs

This directory contains the Application Binary Interfaces (ABIs) for deployed contracts.

## Files

- **AdminV1.json** - JSON format ABI (use with ethers.js, web3.js, etc.)
- **AdminV1.ts** - TypeScript export (imports JSON, provides type safety)

## Usage

### JavaScript/TypeScript (ethers.js v6)

```typescript
import { AdminV1ABI } from "./abis/AdminV1";
import { Contract } from "ethers";

const contract = new Contract(PROXY_ADDRESS, AdminV1ABI, signer);
```

### JavaScript (JSON import)

```javascript
import AdminV1ABI from "./abis/AdminV1.json";
import { Contract } from "ethers";

const contract = new Contract(PROXY_ADDRESS, AdminV1ABI, signer);
```

### React/Next.js

```typescript
import { useContract } from "wagmi";
import { AdminV1ABI } from "./abis/AdminV1";

const { data: contract } = useContract({
  address: PROXY_ADDRESS,
  abi: AdminV1ABI,
});
```

## Important Notes

- **Always use the PROXY_ADDRESS**, not the implementation address
- The proxy address is stored in `deployments.json` after deployment
- Chain ID: 296 (Hedera Testnet)
- All HBAR amounts should be in smallest unit (tinybar)

## Contract Functions

### View Functions
- `bonds(uint256)` - Get bond details
- `issuers(address)` - Get issuer information
- `owner()` - Get contract owner
- `paused()` - Check if contract is paused
- `treasury()` - Get treasury address
- `htsManager()` - Get HTS manager address

### Write Functions
- `registerIssuer(address wallet)` - Register as issuer
- `createBond(...)` - Create a new bond (owner only)
- `approveBond(uint256 bondId)` - Approve a bond (owner only)
- `buyBond(uint256 bondId, uint256 units)` - Purchase bond (payable)
- `redeemBond(uint256 bondId, uint256 units)` - Redeem bond
- `issueBond(uint256 bondId, bytes metadata)` - Issue HTS token (owner only)
- `markMature(uint256 bondId)` - Mark bond as matured (owner only)

### Admin Functions
- `approveKYC(address issuer)` - Approve issuer KYC (owner only)
- `revokeKYC(address issuer)` - Revoke issuer KYC (owner only)
- `pause()` - Pause contract (owner only)
- `unpause()` - Unpause contract (owner only)
- `setHTSManager(address)` - Update HTS manager (owner only)
- `setTreasury(address)` - Update treasury (owner only)

## Events

- `BondCreated(uint256 indexed bondId, address indexed issuer)`
- `BondApproved(uint256 indexed bondId)`
- `BondPurchased(uint256 indexed bondId, address indexed buyer, uint256 amount, uint256 hbarPaid)`
- `BondRedeemed(uint256 indexed bondId, address indexed investor, uint256 hbarPaid)`
- `BondMatured(uint256 indexed bondId)`
- `IssuerRegistered(address indexed issuer, address wallet)`
- `KYCApproved(address indexed issuer)`
- `HTSIssued(uint256 indexed bondId, bytes tokenId)`
- `HTSBurned(uint256 indexed bondId, uint256 amount)`



