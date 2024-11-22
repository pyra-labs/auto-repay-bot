var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import dotenv from "dotenv";
import { getKeypairFromEnvironment } from "@solana-developers/helpers";
import { Connection, Keypair } from "@solana/web3.js";
import { AnchorProvider, Program, setProvider, Wallet } from "@coral-xyz/anchor";
import quartzIdl from "../idl/funds_program.json";
import { QUARTZ_PROGRAM_ID } from "./constants";
import { AutoRepayBot } from "./autoRepayBot";
import { SecretsManagerClient, GetSecretValueCommand, } from "@aws-sdk/client-secrets-manager";
function fetchAWSSecretManagerService() {
    return __awaiter(this, void 0, void 0, function* () {
        const secret_name = process.env.AWS_SECRET_NAME;
        if (!secret_name)
            throw new Error("AWS_SECRET_NAME is not set");
        const region = process.env.AWS_REGION;
        if (!region)
            throw new Error("AWS_REGION is not set");
        const client = new SecretsManagerClient({
            region,
        });
        let response;
        try {
            response = yield client.send(new GetSecretValueCommand({
                SecretId: secret_name,
                VersionStage: "AWSCURRENT",
            }));
        }
        catch (error) {
            throw new Error(`Failed to get secret key from AWS: ${error}`);
        }
        const secret = yield response.SecretString;
        console.log(secret);
        if (!secret)
            throw new Error("Secret string is not set");
        // const keypair = Keypair.fromSecretKey(secret);
        const keypair = Keypair.generate();
        return keypair;
    });
}
function main(useAWS) {
    return __awaiter(this, void 0, void 0, function* () {
        // Initialize connnection
        const RPC_URL = process.env.RPC_URL;
        if (!RPC_URL)
            throw new Error("RPC_URL is not set");
        const connection = new Connection(RPC_URL);
        // Initialize wallet
        const keypair = useAWS
            ? yield fetchAWSSecretManagerService()
            : yield getKeypairFromEnvironment("SECRET_KEY");
        const wallet = new Wallet(keypair);
        // Initialize program
        const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
        setProvider(provider);
        const program = new Program(quartzIdl, QUARTZ_PROGRAM_ID, provider);
        // Initialize AutoRepayBot
        const maxRetries = 3;
        const autoRepayBot = new AutoRepayBot(connection, wallet, program, maxRetries);
        autoRepayBot.run();
    });
}
dotenv.config();
const useAWS = (process.env.USE_AWS === "true");
main(useAWS);
