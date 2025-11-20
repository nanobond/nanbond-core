import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { network, config } from "hardhat";

interface DeploymentAddresses {
  network: string;
  chainId?: number;
  deploymentDate: string;
  contracts: {
    adminV1?: string;
    proxy?: string;
    [key: string]: string | undefined;
  };
  notes?: string;
}

/**
 * Saves deployment addresses to a JSON file
 * Reads from Hardhat Ignition deployment artifacts and saves to deployments.json
 */
async function saveDeploymentAddresses() {
  // Connect to network to get provider
  const { ethers } = await network.connect();
  const networkInfo = await ethers.provider.getNetwork();
  const chainId = Number(networkInfo.chainId);
  
  // Get network name from command line args, environment, or config lookup
  let networkName = process.env.HARDHAT_NETWORK;
  
  // Try to parse from command line args
  if (!networkName) {
    const networkIndex = process.argv.indexOf("--network");
    if (networkIndex !== -1 && process.argv[networkIndex + 1]) {
      networkName = process.argv[networkIndex + 1];
    }
  }
  
  // If still not found, try to match chainId to network config
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
    // Fallback: use chainId-based name
    if (!networkName) {
      networkName = `chain-${chainId}`;
    }
  }

  console.log(`\n📝 Saving deployment addresses for network: ${networkName} (chainId: ${chainId})\n`);

  // Find the latest deployment directory
  const ignitionDir = join(process.cwd(), "ignition", "deployments");
  const chainDir = `chain-${Number(chainId)}`;
  const deploymentDir = join(ignitionDir, chainDir);

  if (!existsSync(deploymentDir)) {
    console.error(`❌ Deployment directory not found: ${deploymentDir}`);
    console.error("   Please run the deployment first using:");
    console.error(`   npx hardhat ignition deploy ignition/modules/AdminProxy.ts --network ${networkName}`);
    process.exit(1);
  }

  // Read deployed_addresses.json if it exists
  const deployedAddressesPath = join(deploymentDir, "deployed_addresses.json");
  let deployedAddresses: Record<string, string> = {};

  if (existsSync(deployedAddressesPath)) {
    deployedAddresses = JSON.parse(readFileSync(deployedAddressesPath, "utf-8"));
    console.log("📦 Found deployment addresses:");
    Object.entries(deployedAddresses).forEach(([key, address]) => {
      console.log(`   ${key}: ${address}`);
    });
  } else {
    console.warn("⚠️  deployed_addresses.json not found. Checking journal...");
    // Try to read from journal.jsonl as fallback
    const journalPath = join(deploymentDir, "journal.jsonl");
    if (existsSync(journalPath)) {
      const journal = readFileSync(journalPath, "utf-8");
      const lines = journal.split("\n").filter((line) => line.trim());
      
      // Extract addresses from journal
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "TRANSACTION_CONFIRM" && entry.receipt?.contractAddress) {
            const futureId = entry.futureId;
            if (futureId) {
              deployedAddresses[futureId] = entry.receipt.contractAddress;
            }
          }
        } catch (e) {
          // Skip invalid JSON lines
        }
      }
    }
  }

  // Extract AdminV1 and Proxy addresses
  // Ignition uses format: "ModuleName#ContractName" or "ModuleName#VariableName"
  const adminV1Key = Object.keys(deployedAddresses).find(
    (key) =>
      key.includes("AdminV1") ||
      key.includes("adminV1") ||
      key.includes("AdminProxy") && key.includes("AdminV1")
  );
  const proxyKey = Object.keys(deployedAddresses).find(
    (key) =>
      key.includes("Proxy") ||
      key.includes("proxy") ||
      key.includes("NanobondProxy") ||
      (key.includes("AdminProxy") && key.includes("Proxy"))
  );

  const adminV1Address = adminV1Key ? deployedAddresses[adminV1Key] : undefined;
  const proxyAddress = proxyKey ? deployedAddresses[proxyKey] : undefined;

  // Create deployment info object
  const deploymentInfo: DeploymentAddresses = {
    network: networkName,
    chainId: Number(chainId),
    deploymentDate: new Date().toISOString(),
    contracts: {
      adminV1: adminV1Address,
      proxy: proxyAddress,
      ...deployedAddresses, // Include all addresses
    },
    notes: "Proxy address is the main contract address to use for interactions. AdminV1 is the implementation.",
  };

  // Save to deployments.json in project root
  const outputPath = join(process.cwd(), "deployments.json");
  writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));

  console.log(`\n✅ Deployment addresses saved to: ${outputPath}\n`);
  console.log("📋 Summary:");
  console.log(`   Network: ${networkName}`);
  console.log(`   Chain ID: ${chainId}`);
  if (adminV1Address) {
    console.log(`   AdminV1 (Implementation): ${adminV1Address}`);
  }
  if (proxyAddress) {
    console.log(`   Proxy (Use this address): ${proxyAddress}`);
  }
  console.log("\n💡 Tip: Use the proxy address for all contract interactions.\n");
}

// Run the script
saveDeploymentAddresses().catch((error) => {
  console.error("❌ Error saving deployment addresses:", error);
  process.exit(1);
});

