import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Use environment variable for versioning if needed, otherwise defaults to AdminV1OnlyModule
// Set DEPLOYMENT_VERSION env var to force a new address: DEPLOYMENT_VERSION=v2 npx hardhat ignition deploy ...
const moduleName = process.env.DEPLOYMENT_VERSION 
  ? `AdminV1OnlyModule_${process.env.DEPLOYMENT_VERSION}`
  : "AdminV1OnlyModule";

export default buildModule(moduleName, (m) => {
  // This module only deploys AdminV1 implementation
  // Used for upgrades - proxy upgrade is handled separately
  const adminV1 = m.contract("AdminV1");

  return {
    adminV1,
  };
});

