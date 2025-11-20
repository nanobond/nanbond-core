import { execSync } from "child_process";
import { network, config } from "hardhat";
import { Contract } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";
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
 * Saves updated deployment addresses
 */
function saveDeployments(deploymentInfo: DeploymentAddresses) {
  const outputPath = join(process.cwd(), "deployments.json");
  writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
}

/**
 * Upgrade script for the UUPS proxy.
 *
 * Steps:
 * 1. Deploy fresh AdminV1 implementation via Ignition.
 * 2. Call upgradeToAndCall on the proxy to point at the new implementation.
 * 3. Update deployments.json with the new implementation metadata.
 *
 * Usage: npx hardhat run scripts/upgrade-admin.ts --network <network>
 */
async function upgradeAdmin() {
  // Get network name
  let networkName = process.env.HARDHAT_NETWORK;
  
  if (!networkName) {
    const networkIndex = process.argv.indexOf("--network");
    if (networkIndex !== -1 && process.argv[networkIndex + 1]) {
      networkName = process.argv[networkIndex + 1];
    }
  }
  
  // Connect to get chainId
  const { ethers: hhEthers } = await network.connect();
  const networkInfo = await hhEthers.provider.getNetwork();
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

  console.log(`\n🔄 Upgrading AdminV1 on ${networkName} (chainId: ${chainId})\n`);

  // Read existing deployments
  const existingDeployments = readDeployments();
  if (!existingDeployments || !existingDeployments.contracts.proxy) {
    throw new Error("No existing proxy deployment found. Please deploy first using deploy-full.ts");
  }

  const proxyAddress = existingDeployments.contracts.proxy;
  const currentAdminV1Address = existingDeployments.contracts.adminV1;
  console.log(`📋 Current Proxy Address: ${proxyAddress}`);
  if (currentAdminV1Address) {
    console.log(`📋 Current AdminV1 Implementation: ${currentAdminV1Address}\n`);
  } else {
    console.log(`📋 Current AdminV1 Implementation: Not found in deployments.json\n`);
  }

  // Check if DEPLOYMENT_VERSION is set to force a new address
  const deploymentVersion = process.env.DEPLOYMENT_VERSION;
  if (deploymentVersion) {
    console.log(`📌 Using DEPLOYMENT_VERSION=${deploymentVersion} to force new address\n`);
  } else {
    console.log(`💡 Tip: Set DEPLOYMENT_VERSION env var to force a new address if needed\n`);
  }

  // Deploy new AdminV1 implementation
  console.log("📦 Phase 1: Deploying new AdminV1 implementation...\n");

  // Deploy new AdminV1 implementation (without proxy)
  // Use --reset to clear Ignition state and force fresh deployment
  execSync(
    `npx hardhat ignition deploy ignition/modules/AdminV1Only.ts --network ${networkName} --reset`,
    { 
      stdio: "inherit",
      env: { ...process.env }
    }
  );

  // Read new AdminV1 address from Ignition artifacts
  const ignitionDir = join(process.cwd(), "ignition", "deployments");
  const chainDir = `chain-${chainId}`;
  const deploymentDir = join(ignitionDir, chainDir);
  const deployedAddressesPath = join(deploymentDir, "deployed_addresses.json");
  const journalPath = join(deploymentDir, "journal.jsonl");
  
  let newAdminV1Address: string | undefined;
  let deployedAddresses: Record<string, string> = {};
  
  // First try to read from deployed_addresses.json
  if (existsSync(deployedAddressesPath)) {
    deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, "utf-8"));
  }
  
  // Also read from journal.jsonl to get the latest deployment
  if (existsSync(journalPath)) {
    const journal = readFileSync(journalPath, "utf-8");
    const lines = journal.split("\n").filter((line) => line.trim());
    
    // Read from the end (most recent) to find the latest AdminV1Only deployment
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "TRANSACTION_CONFIRM" && entry.receipt?.contractAddress) {
          const futureId = entry.futureId;
          if (futureId && (futureId.includes("AdminV1Only") || futureId.includes("adminV1Only"))) {
            deployedAddresses[futureId] = entry.receipt.contractAddress;
          }
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }
  }
  
  // Find AdminV1 address from AdminV1Only module
  const adminV1Key = Object.keys(deployedAddresses).find(
    (key) =>
      (key.includes("AdminV1") || key.includes("adminV1")) &&
      (key.includes("AdminV1Only") || key.includes("adminV1Only"))
  );
  newAdminV1Address = adminV1Key ? deployedAddresses[adminV1Key] : undefined;

  if (!newAdminV1Address) {
    throw new Error("Failed to get new AdminV1 address from deployment");
  }

  console.log(`✅ New AdminV1 deployed at: ${newAdminV1Address}\n`);

  // Check if the new address is different from the current one
  if (currentAdminV1Address && currentAdminV1Address.toLowerCase() === newAdminV1Address.toLowerCase()) {
    console.error("\n⚠️  WARNING: New AdminV1 address is the same as current address!");
    console.error(`   Current: ${currentAdminV1Address}`);
    console.error(`   New:     ${newAdminV1Address}`);
    console.error("\n💡 This usually happens when:");
    console.error("   1. The contract bytecode hasn't changed (same code compiled)");
    console.error("   2. Hardhat Ignition reused the deployment despite --reset");
    console.error("   3. The deployer nonce and parameters are identical");
    console.error("\n🔧 Solutions:");
    console.error("   1. Make sure you've actually changed AdminV1.sol code");
    console.error("   2. Recompile: npx hardhat compile");
    console.error("   3. Force a new address by setting DEPLOYMENT_VERSION:");
    console.error(`      DEPLOYMENT_VERSION=v${Date.now()} npx hardhat run scripts/upgrade-admin.ts --network ${networkName}`);
    console.error("   4. Or manually delete ignition artifacts and redeploy\n");
    
    // Ask if user wants to proceed anyway (upgrade to same address is harmless but pointless)
    console.log("❓ Do you want to proceed with upgrading to the same address?");
    console.log("   (This is harmless but won't change anything)\n");
    
    // For now, we'll throw an error. User can set DEPLOYMENT_VERSION to proceed
    throw new Error("New AdminV1 address matches current address - no upgrade needed. Set DEPLOYMENT_VERSION to force a new address.");
  }

  // Phase 2: Upgrade proxy to new implementation
  console.log("📦 Phase 2: Upgrading proxy to new implementation...\n");
  
  // Connect to proxy contract
  const proxyABI = [
    "function upgradeToAndCall(address newImplementation, bytes memory data) external payable",
    "function owner() external view returns (address)",
  ];

  const signers = await hhEthers.getSigners();
  const signer = signers[0];
  const proxy = new Contract(proxyAddress, proxyABI, signer);

  // Verify we're the owner
  const owner = await proxy.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not the owner. Owner is ${owner}`);
  }

  console.log(`✅ Verified owner: ${owner}\n`);

  console.log("🔄 Calling upgradeToAndCall on proxy...");
  const tx = await proxy.upgradeToAndCall(newAdminV1Address, "0x");
  console.log(`   Transaction hash: ${tx.hash}`);
  console.log("   Waiting for confirmation...");
  
  const receipt = await tx.wait();
  console.log(`✅ Proxy upgraded successfully! Block: ${receipt.blockNumber}\n`);

  // Update deployments.json
  const updatedDeployments: DeploymentAddresses = {
    ...existingDeployments,
    deploymentDate: new Date().toISOString(),
    contracts: {
      ...existingDeployments.contracts,
      adminV1: newAdminV1Address,
      // Proxy address stays the same!
    },
    notes: "Proxy address is the main contract address to use for interactions. AdminV1 is the current implementation. Proxy address never changes.",
  };

  saveDeployments(updatedDeployments);

  console.log("\n✅ Upgrade complete!\n");
  console.log("📋 Summary:");
  console.log(`   Proxy Address (unchanged): ${proxyAddress}`);
  console.log(`   Old AdminV1: ${existingDeployments.contracts.adminV1}`);
  console.log(`   New AdminV1: ${newAdminV1Address}`);
  console.log("\n💡 Tip: The proxy address remains the same - use it for all interactions.\n");
}

upgradeAdmin().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});

