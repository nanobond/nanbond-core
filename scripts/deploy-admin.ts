import { execSync } from "child_process";
import { network, config } from "hardhat";
import { getAddress, isAddress } from "ethers";

/**
 * Converts Hedera address format (0.0.x) to EVM address format (0x...)
 * Hedera account IDs can be converted to EVM addresses
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
    // Convert Hedera account ID to EVM address
    // Hedera account IDs are encoded in the last 20 bytes
    // Format: 0x000000000000000000000000 + account number (padded to 20 bytes)
    const evmAddress = `0x${accountNum.toString(16).padStart(40, "0")}`;
    
    if (isAddress(evmAddress)) {
      return getAddress(evmAddress);
    }
  }

  // If not recognized format, throw error
  throw new Error(
    `Invalid address format: ${hederaAddress}. ` +
    `Expected EVM address (0x...) or Hedera address (0.0.x)`
  );
}

/**
 * Deploys AdminProxy and saves addresses automatically
 * Usage: npx hardhat run scripts/deploy-admin.ts --network <network>
 */
async function deployAdmin() {
  // Get network name from command line args or environment
  let networkName = process.env.HARDHAT_NETWORK;
  
  // If not in env, try to parse from command line args
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
    // Reverse lookup: find network name by chainId
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

  console.log(`\n🚀 Deploying AdminProxy to ${networkName} (chainId: ${chainId})\n`);

  // Get parameters from environment or use defaults
  let htsManagerRaw = process.env.HTS_MANAGER || "0x0000000000000000000000000000000000000000";
  let treasuryRaw = process.env.TREASURY || "0x0000000000000000000000000000000000000000";

  // Convert Hedera addresses to EVM format if needed
  let htsManager: string;
  let treasury: string;
  
  try {
    htsManager = convertHederaToEVM(htsManagerRaw);
    treasury = convertHederaToEVM(treasuryRaw);
  } catch (error) {
    console.error(`\n❌ Address conversion error: ${error instanceof Error ? error.message : error}`);
    console.error("\n💡 Tip: Provide addresses in EVM format (0x...) or Hedera format (0.0.x)\n");
    process.exit(1);
  }

  console.log("📋 Deployment Parameters:");
  if (htsManagerRaw !== htsManager) {
    console.log(`   HTS Manager: ${htsManagerRaw} → ${htsManager}`);
  } else {
    console.log(`   HTS Manager: ${htsManager}`);
  }
  if (treasuryRaw !== treasury) {
    console.log(`   Treasury: ${treasuryRaw} → ${treasury}`);
  } else {
    console.log(`   Treasury: ${treasury}`);
  }
  console.log();

  if (htsManager === "0x0000000000000000000000000000000000000000") {
    console.warn("⚠️  Warning: HTS_MANAGER is not set, using zero address");
  }
  if (treasury === "0x0000000000000000000000000000000000000000") {
    console.warn("⚠️  Warning: TREASURY is not set, using zero address");
  }

  try {
    // Deploy using Hardhat Ignition
    // Pass addresses via environment variables to avoid Ignition parameter bug
    console.log("📦 Deploying contracts...\n");
    execSync(
      `HTS_MANAGER="${htsManager}" TREASURY="${treasury}" npx hardhat ignition deploy ignition/modules/AdminProxy.ts --network ${networkName}`,
      { 
        stdio: "inherit",
        env: { ...process.env, HTS_MANAGER: htsManager, TREASURY: treasury }
      }
    );

    console.log("\n💾 Saving deployment addresses...\n");
    // Save addresses
    execSync(`npx hardhat run scripts/save-deployment-addresses.ts --network ${networkName}`, {
      stdio: "inherit",
    });

    console.log("\n✅ Deployment complete!\n");
  } catch (error) {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  }
}

deployAdmin().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});

