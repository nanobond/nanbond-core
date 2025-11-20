import { execSync } from "child_process";
import { network, config } from "hardhat";
import { getAddress, isAddress } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

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
 * Reads deployment addresses from Ignition deployment artifacts
 * Reads from the latest deployment (most recent journal.jsonl)
 */
function readDeploymentAddresses(chainId: number): Record<string, string> {
  const ignitionDir = join(process.cwd(), "ignition", "deployments");
  const chainDir = `chain-${chainId}`;
  const deploymentDir = join(ignitionDir, chainDir);

  if (!existsSync(deploymentDir)) {
    throw new Error(`Deployment directory not found: ${deploymentDir}`);
  }

  const deployedAddressesPath = join(deploymentDir, "deployed_addresses.json");
  let deployedAddresses: Record<string, string> = {};

  // First try to read from deployed_addresses.json (latest)
  if (existsSync(deployedAddressesPath)) {
    deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, "utf-8"));
  }

  // Also read from journal.jsonl to get all deployments
  const journalPath = join(deploymentDir, "journal.jsonl");
  if (existsSync(journalPath)) {
    const journal = readFileSync(journalPath, "utf-8");
    const lines = journal.split("\n").filter((line) => line.trim());
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "TRANSACTION_CONFIRM" && entry.receipt?.contractAddress) {
          const futureId = entry.futureId;
          if (futureId) {
            // Merge with existing addresses (journal has all deployments)
            deployedAddresses[futureId] = entry.receipt.contractAddress;
          }
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }
  }

  return deployedAddresses;
}

/**
 * Saves deployment addresses to deployments.json
 */
function saveDeploymentAddresses(
  networkName: string,
  chainId: number,
  deployedAddresses: Record<string, string>
) {
  // Extract contract addresses
  const htsManagerKey = Object.keys(deployedAddresses).find(
    (key) => key.includes("HTSManager") || key.includes("htsManager")
  );
  const adminV1Key = Object.keys(deployedAddresses).find(
    (key) =>
      key.includes("AdminV1") ||
      key.includes("adminV1") ||
      (key.includes("FullDeployment") && key.includes("AdminV1"))
  );
  const proxyKey = Object.keys(deployedAddresses).find(
    (key) =>
      key.includes("Proxy") ||
      key.includes("proxy") ||
      key.includes("NanobondProxy") ||
      (key.includes("FullDeployment") && key.includes("Proxy"))
  );

  const htsManagerAddress = htsManagerKey ? deployedAddresses[htsManagerKey] : undefined;
  const adminV1Address = adminV1Key ? deployedAddresses[adminV1Key] : undefined;
  const proxyAddress = proxyKey ? deployedAddresses[proxyKey] : undefined;

  const deploymentInfo: DeploymentAddresses = {
    network: networkName,
    chainId: chainId,
    deploymentDate: new Date().toISOString(),
    contracts: {
      htsManager: htsManagerAddress,
      adminV1: adminV1Address,
      proxy: proxyAddress,
      ...deployedAddresses, // Include all addresses from Ignition
    },
    notes: "Proxy address is the main contract address to use for interactions. HTSManager handles Hedera token operations. AdminV1 is the implementation.",
  };

  const outputPath = join(process.cwd(), "deployments.json");
  writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));

  console.log(`\n✅ Deployment addresses saved to: ${outputPath}\n`);
  console.log("📋 Summary:");
  console.log(`   Network: ${networkName}`);
  console.log(`   Chain ID: ${chainId}`);
  if (htsManagerAddress) {
    console.log(`   HTSManager: ${htsManagerAddress}`);
  }
  if (adminV1Address) {
    console.log(`   AdminV1 (Implementation): ${adminV1Address}`);
  }
  if (proxyAddress) {
    console.log(`   Proxy (Use this address): ${proxyAddress}`);
  }
  console.log("\n💡 Tip: Use the proxy address for all AdminV1 contract interactions.\n");
}

/**
 * Full deployment script: Deploys HTSManager, AdminV1, and Proxy
 * Usage: npx hardhat run scripts/deploy-full.ts --network <network>
 */
async function deployFull() {
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

  console.log(`\n🚀 Full Deployment to ${networkName} (chainId: ${chainId})\n`);
  console.log("📦 This will deploy:");
  console.log("   1. HTSManager contract");
  console.log("   2. AdminV1 implementation contract");
  console.log("   3. NanobondProxy contract (linked to AdminV1)");
  console.log("   4. Initialize AdminV1 with HTSManager and Treasury addresses\n");

  // Get treasury address from environment
  let treasuryRaw = process.env.TREASURY || "0x0000000000000000000000000000000000000000";
  let treasury: string;
  
  try {
    treasury = convertHederaToEVM(treasuryRaw);
  } catch (error) {
    console.error(`\n❌ Address conversion error: ${error instanceof Error ? error.message : error}`);
    console.error("\n💡 Tip: Provide TREASURY address in EVM format (0x...) or Hedera format (0.0.x)\n");
    process.exit(1);
  }

  console.log("📋 Deployment Parameters:");
  if (treasuryRaw !== treasury) {
    console.log(`   Treasury: ${treasuryRaw} → ${treasury}`);
  } else {
    console.log(`   Treasury: ${treasury}`);
  }
  console.log();

  if (treasury === "0x0000000000000000000000000000000000000000") {
    console.warn("⚠️  Warning: TREASURY is not set, using zero address");
    console.warn("   Set TREASURY environment variable before deployment\n");
  }

  try {
    // Phase 1: Deploy HTSManager first
    console.log("📦 Phase 1: Deploying HTSManager...\n");
    execSync(
      `npx hardhat ignition deploy ignition/modules/HTSManager.ts --network ${networkName}`,
      { 
        stdio: "inherit",
        env: { ...process.env }
      }
    );

    // Read HTSManager address from deployment
    console.log("\n💾 Reading HTSManager address...\n");
    const htsManagerAddresses = readDeploymentAddresses(chainId);
    const htsManagerKey = Object.keys(htsManagerAddresses).find(
      (key) => key.includes("HTSManager") || key.includes("htsManager")
    );
    const htsManagerAddress = htsManagerKey ? htsManagerAddresses[htsManagerKey] : undefined;

    if (!htsManagerAddress) {
      throw new Error("Failed to get HTSManager address from deployment");
    }

    console.log(`✅ HTSManager deployed at: ${htsManagerAddress}\n`);

    // Get deployer address (owner)
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const ownerAddress = deployer.address;
    console.log(`👤 Deployer (Owner): ${ownerAddress}\n`);

    // Phase 2: Deploy AdminV1 and Proxy with HTSManager address
    // Use --reset to clear previous deployment state since we changed the initialize signature
    console.log("📦 Phase 2: Deploying AdminV1 and Proxy...\n");
    execSync(
      `HTS_MANAGER="${htsManagerAddress}" TREASURY="${treasury}" OWNER="${ownerAddress}" npx hardhat ignition deploy ignition/modules/FullDeployment.ts --network ${networkName} --reset`,
      { 
        stdio: "inherit",
        env: { ...process.env, HTS_MANAGER: htsManagerAddress, TREASURY: treasury, OWNER: ownerAddress }
      }
    );

    console.log("\n💾 Reading all deployment addresses...\n");
    // Read all addresses from Ignition artifacts
    const allDeployedAddresses = readDeploymentAddresses(chainId);
    
    console.log("📦 Found deployment addresses:");
    Object.entries(allDeployedAddresses).forEach(([key, address]) => {
      console.log(`   ${key}: ${address}`);
    });

    console.log("\n💾 Saving deployment addresses...\n");
    // Save addresses to deployments.json
    saveDeploymentAddresses(networkName, chainId, allDeployedAddresses);

    console.log("\n✅ Full deployment complete!\n");
    console.log("🎉 All contracts deployed and linked successfully!\n");
  } catch (error) {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  }
}

deployFull().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});


