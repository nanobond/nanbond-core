# Nanobond Core

Core smart contracts for the Nanobond protocol on Hedera Hashgraph. This repository contains the Solidity contracts for bond issuance, management, and trading using the Hedera Token Service (HTS).

## Audit & Security

![Audited by Gemini Google](https://img.shields.io/badge/Audited%20by-Gemini%20Google-blue)

These contracts have been audited by Gemini Google. The full audit report can be found in [AUDIT_REPORT.md](./AUDIT_REPORT.md).

## Deployments

### Hedera Mainnet (Chain ID 295)

*   **AdminV1**: `0xA620147a4016953c5Cc516e726ed787E7e70b5Df`
    *   [Sourcify Verified](https://sourcify.dev/server/repo-ui/295/0xA620147a4016953c5Cc516e726ed787E7e70b5Df)
*   **NanobondProxy**: `0x5Df533C51af3FdE2C05a0863E28C089605cd16fE`
    *   [Sourcify Verified](https://sourcify.dev/server/repo-ui/295/0x5Df533C51af3FdE2C05a0863E28C089605cd16fE)

### Hedera Testnet (Chain ID 296)

*   **AdminV1**: `0x4E99fdCe12bE3d7500259ef57FdCfBfEC61Ff113`
*   **NanobondProxy**: *(Please verify latest deployment)*

## Features

*   **Bond Lifecycle Management**: Create, approve, issue, mature, and redeem bonds.
*   **HTS Integration**: Mints Hedera native tokens representing bonds.
*   **KYC/AML**: Whitelist-based issuer verification.
*   **Lobe for Hedera Community**: Integrates with the Lobe ecosystem for enhanced community engagement and tooling.

## Build & Test

This project is a Hardhat project.

```shell
# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test
```