import dotenv from "dotenv";
import { getKeypairFromEnvironment } from "@solana-developers/helpers";
import { Connection } from "@solana/web3.js";
import { AnchorProvider, Idl, Program, setProvider, Wallet } from "@coral-xyz/anchor";
import quartzIdl from "../idl/funds_program.json";
import { FundsProgram } from "../idl/funds_program";
import { QUARTZ_PROGRAM_ID } from "./constants";
import { AutoRepayBot } from "./autoRepayBot";

// Initialize connnection and wallet
dotenv.config();
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("RPC_URL is not set");

const connection = new Connection(RPC_URL);
const keypair = getKeypairFromEnvironment("SECRET_KEY");
const wallet = new Wallet(keypair);

// Initialize program
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
setProvider(provider);
const program = new Program(quartzIdl as Idl, QUARTZ_PROGRAM_ID, provider) as unknown as Program<FundsProgram>;

// Initialize AutoRepayBot
const maxRetries = 3;
const autoRepayBot = new AutoRepayBot(connection, wallet, program, maxRetries);
autoRepayBot.run();
