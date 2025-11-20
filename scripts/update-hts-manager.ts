import { execSync } from "child_process";
import { network, config } from "hardhat";
import { getAddress, isAddress, Contract, Interface } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * Converts Hedera address format (0.0.x) to EVM address format (0x...)
 */
function convertHederaToEVM(hederaAddress: string): string {
  if (hederaAddress.startsWith("0x") && isAddress(hederaAddress)) {
    return getAddress(hederaAddress);
  }

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

function readDeployments(): DeploymentAddresses {
  const deploymentsPath = join(process.cwd(), "deployments.json");
  if (!existsSync(deploymentsPath)) {
    throw new Error("deployments.json not found. Please deploy contracts first.");
  }
  return JSON.parse(readFileSync(deploymentsPath, "utf-8"));
}

function saveDeployments(deployments: DeploymentAddresses) {
  const deploymentsPath = join(process.cwd(), "deployments.json");
  writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
}

function readDeploymentAddresses(chainId: number): Record<string, string> {
  const ignitionDir = join(process.cwd(), "ignition", "deployments");
  const chainDir = `chain-${chainId}`;
  const deploymentDir = join(ignitionDir, chainDir);
  const deployedAddressesPath = join(deploymentDir, "deployed_addresses.json");
  
  const addresses: Record<string, string> = {};
  
  if (existsSync(deployedAddressesPath)) {
    const deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, "utf-8"));
    Object.assign(addresses, deployedAddresses);
  }
  
  // Also read from journal.jsonl for latest deployments
  const journalPath = join(deploymentDir, "journal.jsonl");
  if (existsSync(journalPath)) {
    const journalLines = readFileSync(journalPath, "utf-8").split("\n").filter(Boolean);
    for (const line of journalLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.future && entry.future.id && entry.address) {
          addresses[entry.future.id] = entry.address;
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }
  }
  
  return addresses;
}

async function updateHTSManager() {
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
  
  // If still no network name, try to match chainId to network config
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

  console.log(`\n🔄 Updating HTSManager on ${networkName} (chainId: ${chainId})\n`);

  // Read existing deployments
  const existingDeployments = readDeployments();
  const proxyAddress = existingDeployments.contracts.proxy;

  if (!proxyAddress) {
    throw new Error("Proxy address not found in deployments.json. Please deploy contracts first.");
  }

  console.log(`📋 Current Configuration:`);
  console.log(`   Proxy Address: ${proxyAddress}`);
  if (existingDeployments.contracts.htsManager) {
    console.log(`   Current HTSManager: ${existingDeployments.contracts.htsManager}`);
  }
  console.log();

  // Phase 1: Deploy new HTSManager
  // Use --reset to force a new deployment even if HTSManager was deployed before
  console.log("📦 Phase 1: Deploying new HTSManager...\n");
  console.log("   Note: Using --reset to ensure a fresh deployment\n");
  execSync(
    `npx hardhat ignition deploy ignition/modules/HTSManager.ts --network ${networkName} --reset`,
    { 
      stdio: "inherit",
      env: { ...process.env }
    }
  );

  // Read new HTSManager address from deployment
  console.log("\n💾 Reading new HTSManager address...\n");
  const deployedAddresses = readDeploymentAddresses(chainId);
  const htsManagerKey = Object.keys(deployedAddresses).find(
    (key) => key.includes("HTSManager") || key.includes("htsManager")
  );
  const newHTSManagerAddress = htsManagerKey ? deployedAddresses[htsManagerKey] : undefined;

  if (!newHTSManagerAddress) {
    throw new Error("Failed to get new HTSManager address from deployment");
  }

  console.log(`✅ New HTSManager deployed at: ${newHTSManagerAddress}\n`);

  // Check if the new address is different from the current one
  const currentHTSManager = existingDeployments.contracts.htsManager;
  if (currentHTSManager && currentHTSManager.toLowerCase() === newHTSManagerAddress.toLowerCase()) {
    console.error("\n❌ ERROR: New HTSManager address is the same as current address!");
    console.error(`   Current: ${currentHTSManager}`);
    console.error(`   New:     ${newHTSManagerAddress}`);
    console.error("\n💡 This usually happens when:");
    console.error("   1. The contract code hasn't changed (compiler produces same bytecode)");
    console.error("   2. Ignition reused the deployment despite --reset");
    console.error("\n🔧 Solutions:");
    console.error("   1. Make sure you've actually changed the HTSManager.sol code");
    console.error("   2. Recompile: npx hardhat compile");
    console.error("   3. Try deleting ignition/deployments/chain-296/artifacts/HTSManagerModule*");
    console.error("   4. Or manually deploy with a different module name\n");
    throw new Error("New HTSManager address matches current address - no update needed");
  }

  // Phase 2: Update AdminV1 via proxy
  console.log("📦 Phase 2: Updating HTSManager in AdminV1...\n");
  
  // Connect to proxy contract
  const proxyABI = [
    "function setHTSManager(address _m) external",
    "function owner() external view returns (address)",
    "function htsManager() external view returns (address)",
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

  // Check current HTSManager
  try {
    const currentHTSManager = await proxy.htsManager();
    console.log(`📋 Current HTSManager: ${currentHTSManager}`);
    if (currentHTSManager.toLowerCase() === newHTSManagerAddress.toLowerCase()) {
      console.log("⚠️  Warning: New HTSManager address is the same as current address!");
    }
    console.log();
  } catch (error) {
    console.log("⚠️  Could not read current HTSManager (this is okay if contract wasn't initialized)\n");
  }

  // Update HTSManager
  console.log("🔄 Calling setHTSManager on proxy...");
  const tx = await proxy.setHTSManager(newHTSManagerAddress);
  console.log(`   Transaction hash: ${tx.hash}`);
  console.log("   Waiting for confirmation...");
  
  const receipt = await tx.wait();
  console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}\n`);

  // Verify update
  const updatedHTSManager = await proxy.htsManager();
  if (updatedHTSManager.toLowerCase() !== newHTSManagerAddress.toLowerCase()) {
    throw new Error("Failed to update HTSManager - verification failed");
  }

  console.log(`✅ Verified: HTSManager updated to ${updatedHTSManager}\n`);

  // Update deployments.json
  const updatedDeployments: DeploymentAddresses = {
    ...existingDeployments,
    deploymentDate: new Date().toISOString(),
    contracts: {
      ...existingDeployments.contracts,
      htsManager: newHTSManagerAddress,
      // Proxy and AdminV1 addresses stay the same
    },
    notes: "Proxy address is the main contract address to use for interactions. HTSManager updated. Proxy address never changes.",
  };

  saveDeployments(updatedDeployments);

  console.log("\n✅ HTSManager update complete!\n");
  console.log("📋 Summary:");
  console.log(`   Proxy Address (unchanged): ${proxyAddress}`);
  if (existingDeployments.contracts.htsManager) {
    console.log(`   Old HTSManager: ${existingDeployments.contracts.htsManager}`);
  }
  console.log(`   New HTSManager: ${newHTSManagerAddress}`);
  console.log("\n💡 Tip: The proxy address remains the same - use it for all interactions.\n");
}

updateHTSManager().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});

