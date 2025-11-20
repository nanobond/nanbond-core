import AdminV1ABIJson from "./AdminV1.json";

/**
 * AdminV1 Contract ABI
 * 
 * This is the ABI for the AdminV1 contract deployed via proxy pattern.
 * Use the PROXY_ADDRESS (not implementation address) when interacting with this contract.
 * 
 * @example
 * ```typescript
 * import { AdminV1ABI } from "./abis/AdminV1";
 * import { Contract } from "ethers";
 * 
 * const contract = new Contract(PROXY_ADDRESS, AdminV1ABI, signer);
 * ```
 */
export const AdminV1ABI = AdminV1ABIJson;

export default AdminV1ABI;
