import express from 'express';
import { json, Request, Response } from 'express';
import { Connection, Keypair } from "@solana/web3.js";
import { AnchorProvider, Idl, Program, setProvider, Wallet } from "@coral-xyz/anchor";
import quartzIdl from "./idl/funds_program.json";
import { FundsProgram } from "./idl/funds_program";
import { QUARTZ_PROGRAM_ID } from "./config/constants.js";
import { AutoRepayBot } from "./autoRepayBot.js";
import {
    SecretsManagerClient,
    GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import config from './config/config.js';

async function fetchAWSSecretManagerService() {
    const secret_name = config.AWS_SECRET_NAME;
    if (!secret_name) throw new Error("AWS_SECRET_NAME is not set");

    const region = config.AWS_REGION;
    if (!region) throw new Error("AWS_REGION is not set");

    const client = new SecretsManagerClient({
        region,
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
    
    const secretString = await response.SecretString;
    if (!secretString) throw new Error("Secret string is not set");
    const secret = JSON.parse(secretString);
    const secretArray = new Uint8Array(JSON.parse(secret.liquidatorSecret));
    const keypair = Keypair.fromSecretKey(secretArray);
    
    return keypair;
}

async function main() {
    // Initialize endpoint
    const app = express();
    const port = config.PORT;
    app.use(json());
    app.get('/', (req: Request, res: Response) => {
        res.status(200).json({ status: 'OK' });
    });
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
    });

    // Initialize connnection
    const RPC_URL = config.RPC_URL;
    if (!RPC_URL) throw new Error("RPC_URL is not set");
    const connection = new Connection(RPC_URL);

    // Initialize wallet
    const keypair = (config.USE_AWS) 
        ? await fetchAWSSecretManagerService() 
        : Keypair.fromSecretKey(config.WALLET_KEYPAIR);
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
