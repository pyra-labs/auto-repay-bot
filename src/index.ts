import "dotenv/config";
import { getKeypairFromEnvironment } from "@solana-developers/helpers";
import { Connection } from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("RPC_URL is not set");

const connection = new Connection(RPC_URL);
const keypair = getKeypairFromEnvironment("SECRET_KEY");
