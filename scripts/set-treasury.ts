import { network, config } from "hardhat";
import { Contract } from "ethers";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getAddress, isAddress } from "ethers";

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
 * Converts Hedera address format (0.0.x) to EVM address format (0x...)
 */
function convertHederaToEVM(hederaAddress: string): string {
  // If already EVM format, return as-is
  if (hederaAddress.startsWith("0x") && isAddress(hederaAddress)) {
    return getAddress(hederaAddress);
  }

  // Check if it's Hedera format (0.0.x)
  const hederaPattern = /^0\.0\.(\d+)$/;
  const match = hederaAddress.match(hederaPattern);
  
  if (match) {
    const accountNum = BigInt(match[1]);
    const evmAddress = `0x${accountNum.toString(16).padStart(40, "0")}`;
    
    if (isAddress(evmAddress)) {
      return getAddress(evmAddress);
    }
  }

  throw new Error(
    `Invalid address format: ${hederaAddress}. ` +
    `Expected EVM address (0x...) or Hedera address (0.0.x)`
  );
}

/**
 * Script to set the treasury address on the AdminV1 proxy contract.
 *
 * Usage: npx hardhat run scripts/set-treasury.ts --network <network>
 * 
 * You can set the treasury address via:
 * 1. Command line argument: --treasury 0x...
 * 2. Environment variable: TREASURY=0x...
 * 3. Default: 0x00000000000000000000000000000000006d6bc2
 */
async function setTreasury() {
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

  console.log(`\n💰 Setting Treasury Address on ${networkName} (chainId: ${chainId})\n`);

  // Read existing deployments
  const existingDeployments = readDeployments();
  if (!existingDeployments || !existingDeployments.contracts.proxy) {
    throw new Error("No existing proxy deployment found. Please deploy first using deploy-full.ts");
  }

  const proxyAddress = existingDeployments.contracts.proxy;
  console.log(`📋 Proxy Address: ${proxyAddress}\n`);

  // Get treasury address from command line, environment, or use default
  let treasuryRaw: string | undefined;
  
  // Check command line arguments
  const treasuryIndex = process.argv.indexOf("--treasury");
  if (treasuryIndex !== -1 && process.argv[treasuryIndex + 1]) {
    treasuryRaw = process.argv[treasuryIndex + 1];
  }
  
  // Check environment variable
  if (!treasuryRaw) {
    treasuryRaw = process.env.TREASURY;
  }
  
  // Use default if not provided
  if (!treasuryRaw) {
    treasuryRaw = "0x00000000000000000000000000000000006d6bc2";
    console.log("📌 Using default treasury address\n");
  }

  // Convert to EVM format if needed
  let treasury: string;
  try {
    treasury = convertHederaToEVM(treasuryRaw);
    if (treasuryRaw !== treasury) {
      console.log(`📋 Treasury: ${treasuryRaw} → ${treasury}\n`);
    } else {
      console.log(`📋 Treasury: ${treasury}\n`);
    }
  } catch (error) {
    console.error(`\n❌ Address conversion error: ${error instanceof Error ? error.message : error}`);
    console.error("\n💡 Tip: Provide TREASURY address in EVM format (0x...) or Hedera format (0.0.x)\n");
    process.exit(1);
  }

  // Connect to proxy contract
  const proxyABI = [
    "function setTreasury(address _t) external",
    "function treasury() external view returns (address)",
    "function owner() external view returns (address)",
  ];

  const signers = await ethers.getSigners();
  const signer = signers[0];
  const proxy = new Contract(proxyAddress, proxyABI, signer);

  // Verify we're the owner
  const owner = await proxy.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the owner. Owner is ${owner}`);
  }

  console.log(`✅ Verified owner: ${owner}\n`);

  // Check current treasury address
  const currentTreasury = await proxy.treasury();
  console.log(`📋 Current Treasury: ${currentTreasury}`);
  console.log(`📋 New Treasury:     ${treasury}\n`);

  if (currentTreasury.toLowerCase() === treasury.toLowerCase()) {
    console.log("ℹ️  Treasury address is already set to this value. No action needed.\n");
    return;
  }

  // Set treasury address
  console.log("🔄 Calling setTreasury on proxy...");
  const tx = await proxy.setTreasury(treasury);
  console.log(`   Transaction hash: ${tx.hash}`);
  console.log("   Waiting for confirmation...");
  
  const receipt = await tx.wait();
  console.log(`✅ Treasury address set successfully! Block: ${receipt.blockNumber}\n`);

  // Verify the change
  const updatedTreasury = await proxy.treasury();
  if (updatedTreasury.toLowerCase() === treasury.toLowerCase()) {
    console.log(`✅ Verified: Treasury is now set to ${updatedTreasury}\n`);
  } else {
    console.error(`❌ Warning: Treasury verification failed. Expected ${treasury}, got ${updatedTreasury}\n`);
  }
}

setTreasury().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});

