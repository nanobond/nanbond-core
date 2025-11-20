import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { Interface } from "ethers";

export default buildModule("AdminProxyModule", (m) => {
  const adminV1 = m.contract("AdminV1");

  const treasury = process.env.TREASURY || "0x0000000000000000000000000000000000000000";
  const owner = process.env.OWNER || "0x0000000000000000000000000000000000000000";

  if (!treasury.startsWith("0x") || treasury.length !== 42) {
    throw new Error(`Invalid treasury address: ${treasury}. Must be a valid EVM address (0x...).`);
  }

  if (!owner.startsWith("0x") || owner.length !== 42) {
    throw new Error(`Invalid owner address: ${owner}. Must be a valid EVM address (0x...).`);
  }

  const adminV1Interface = new Interface([
    "function initialize(address _legacyHTSManager, address _treasury, address _owner)",
  ]);

  const initData: string = adminV1Interface.encodeFunctionData("initialize", [
    "0x0000000000000000000000000000000000000000",
    treasury,
    owner,
  ]);

  const proxy = m.contract("NanobondProxy", [adminV1, initData]);

  return {
    adminV1,
    proxy,
  };
});
