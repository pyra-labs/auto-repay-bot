import dotenv from "dotenv";
import { getKeypairFromEnvironment } from "@solana-developers/helpers";
import { Connection, Keypair } from "@solana/web3.js";
import { AnchorProvider, Idl, Program, setProvider, Wallet } from "@coral-xyz/anchor";
import quartzIdl from "../idl/funds_program.json";
import { FundsProgram } from "../idl/funds_program";
import { QUARTZ_PROGRAM_ID } from "./constants";
import { AutoRepayBot } from "./autoRepayBot";
import {
    SecretsManagerClient,
    GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

async function fetchAWSSecretManagerService() {
    const secret_name = "liquidatorCredentials";
    const client = new SecretsManagerClient({
        region: "eu-north-1",
    });

    let response;
    try {
        response = await client.send(
            new GetSecretValueCommand({
                SecretId: secret_name,
                VersionStage: "AWSCURRENT",
            })
        );
    } catch (error) {
        throw new Error(`Failed to get secret key from AWS: ${error}`);
    }
    const secret = response.SecretString;

    console.log(secret);
    const keypair = Keypair.fromSecretKey(secret);

    return keypair;
}

async function main() {
    // Initialize connnection
    dotenv.config();
    const RPC_URL = process.env.RPC_URL;
    if (!RPC_URL) throw new Error("RPC_URL is not set");
    const connection = new Connection(RPC_URL);

    // Initialize wallet
    const keypair = await getKeypairFromEnvironment("SECRET_KEY"); // If using .env file to store secret key (only recommended if self-hosting)
    // const keypair = await fetchAWSSecretManagerService(); // If using AWS Secret Manager service to store secret key
    const wallet = new Wallet(keypair);

    // Initialize program
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
    setProvider(provider);
    const program = new Program(quartzIdl as Idl, QUARTZ_PROGRAM_ID, provider) as unknown as Program<FundsProgram>;

    // Initialize AutoRepayBot
    const maxRetries = 3;
    const autoRepayBot = new AutoRepayBot(connection, wallet, program, maxRetries);
    autoRepayBot.run();
}

main();
