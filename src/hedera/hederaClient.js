import { Client, PrivateKey } from "@hashgraph/sdk";
import dotenv from "dotenv";

dotenv.config();

let clientInstance = null;

export const getHederaClient = () => {
  if (!clientInstance) {
    clientInstance = Client.forName(process.env.HEDERA_NETWORK).setOperator(
      process.env.HEDERA_ACCOUNT_ID,
      PrivateKey.fromString(process.env.HEDERA_PRIVATE_KEY)
    );
  }
  return clientInstance;
};
