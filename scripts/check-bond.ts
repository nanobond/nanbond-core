import { network, config } from "hardhat";
import { Contract } from "ethers";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

interface DeploymentAddresses {
  network: string;
  chainId?: number;
  deploymentDate: string;
  contracts: {
    htsManager?: string;
    adminV1?: string;
    proxy?: string;
    [key: string]: string | undefined;
  };
  notes?: string;
}

/**
 * Reads deployment addresses from deployments.json
 */
function readDeployments(): DeploymentAddresses | null {
  const deploymentsPath = join(process.cwd(), "deployments.json");
  if (!existsSync(deploymentsPath)) {
    return null;
  }
  return JSON.parse(readFileSync(deploymentsPath, "utf-8"));
}

/**
 * Quick script to check bond issuer address.
 *
 * Usage: 
 *   # Check bond 12 (default)
 *   npx hardhat run scripts/check-bond.ts --network <network>
 * 
 *   # Check specific bond ID
 *   npx hardhat run scripts/check-bond.ts --network <network> --bond-id 12
 * 
 *   # Show full bond details
 *   npx hardhat run scripts/check-bond.ts --network <network> --bond-id 12 --verbose
 */
async function checkBond() {
  // Get network name
  let networkName = process.env.HARDHAT_NETWORK;
  
  if (!networkName) {
    const networkIndex = process.argv.indexOf("--network");
    if (networkIndex !== -1 && process.argv[networkIndex + 1]) {
      networkName = process.argv[networkIndex + 1];
    }
  }
  
  // Connect to get chainId
  const { ethers } = await network.connect();
  const networkInfo = await ethers.provider.getNetwork();
  const chainId = Number(networkInfo.chainId);
  
  if (!networkName) {
    const networks = config.networks;
    for (const [name, netConfig] of Object.entries(networks)) {
      if (netConfig && typeof netConfig === 'object' && 'chainId' in netConfig) {
        if (Number(netConfig.chainId) === chainId) {
          networkName = name;
          break;
        }
      }
    }
    if (!networkName) {
      networkName = `chain-${chainId}`;
    }
  }

  // Get bond ID from command line or use default (12)
  let bondId = 12;
  const bondIdIndex = process.argv.indexOf("--bond-id");
  if (bondIdIndex !== -1 && process.argv[bondIdIndex + 1]) {
    bondId = parseInt(process.argv[bondIdIndex + 1], 10);
    if (isNaN(bondId)) {
      throw new Error(`Invalid bond ID: ${process.argv[bondIdIndex + 1]}`);
    }
  }

  console.log(`\n🔍 Checking Bond #${bondId} on ${networkName} (chainId: ${chainId})\n`);

  // Read existing deployments
  const existingDeployments = readDeployments();
  if (!existingDeployments || !existingDeployments.contracts.proxy) {
    throw new Error("No existing proxy deployment found. Please deploy first using deploy-full.ts");
  }

  const proxyAddress = existingDeployments.contracts.proxy;
  console.log(`📋 Proxy Address: ${proxyAddress}\n`);

  // Connect to proxy contract
  // Using the AdminV1 ABI to access bonds mapping
  const proxyABI = [
    "function bonds(uint256) external view returns (uint256 id, address issuer, uint256 interestRateBP, uint256 couponRateBP, uint256 faceValue, uint256 availableUnits, uint256 targetUSD, uint256 durationSec, uint256 maturityTimestamp, uint8 status, bytes memory htsTokenId, uint256 issuedUnits)",
  ];

  const signers = await ethers.getSigners();
  const signer = signers[0];
  const proxy = new Contract(proxyAddress, proxyABI, signer);

  try {
    // Call bonds(bondId) to get the Bond struct
    const bond = await proxy.bonds(bondId);
    
    // Extract issuer address (second element in the tuple)
    const issuer = bond.issuer;
    
    console.log(`✅ Bond #${bondId} Issuer Address: ${issuer}\n`);
    
    // Optionally show more details
    const showDetails = process.argv.includes("--verbose") || process.argv.includes("-v");
    if (showDetails) {
      console.log(`📋 Bond #${bondId} Details:`);
      console.log(`   ID: ${bond.id.toString()}`);
      console.log(`   Issuer: ${issuer}`);
      console.log(`   Interest Rate: ${bond.interestRateBP.toString()} BP (${(Number(bond.interestRateBP) / 100).toFixed(2)}%)`);
      console.log(`   Coupon Rate: ${bond.couponRateBP.toString()} BP (${(Number(bond.couponRateBP) / 100).toFixed(2)}%)`);
      console.log(`   Face Value: ${bond.faceValue.toString()}`);
      console.log(`   Available Units: ${bond.availableUnits.toString()}`);
      console.log(`   Target USD: ${bond.targetUSD.toString()}`);
      console.log(`   Duration: ${bond.durationSec.toString()} seconds`);
      console.log(`   Maturity Timestamp: ${bond.maturityTimestamp.toString()}`);
      console.log(`   Status: ${bond.status} (${getBondStatusName(bond.status)})`);
      console.log(`   Issued Units: ${bond.issuedUnits.toString()}`);
      console.log(`   HTS Token ID: ${bond.htsTokenId.length > 0 ? ethers.hexlify(bond.htsTokenId) : "Not set"}\n`);
    }
    
    return issuer;
  } catch (error: any) {
    if (error.message && error.message.includes("revert")) {
      console.error(`❌ Error: Bond #${bondId} may not exist or the call reverted.`);
      console.error(`   Make sure bond ID ${bondId} has been created.\n`);
    } else {
      console.error(`❌ Error reading bond: ${error.message}\n`);
    }
    throw error;
  }
}

/**
 * Helper function to get BondStatus name
 */
function getBondStatusName(status: number): string {
  const statuses = [
    "Draft",
    "Submitted", 
    "InReview",
    "Approved",
    "Issued",
    "Matured",
    "Settled"
  ];
  return statuses[status] || `Unknown(${status})`;
}

checkBond().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});

