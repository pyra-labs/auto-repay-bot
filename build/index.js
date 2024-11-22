"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const helpers_1 = require("@solana-developers/helpers");
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const funds_program_json_1 = __importDefault(require("./idl/funds_program.json"));
const constants_js_1 = require("./constants.js");
const autoRepayBot_js_1 = require("./autoRepayBot.js");
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
function fetchAWSSecretManagerService() {
    return __awaiter(this, void 0, void 0, function* () {
        const secret_name = process.env.AWS_SECRET_NAME;
        if (!secret_name)
            throw new Error("AWS_SECRET_NAME is not set");
        const region = process.env.AWS_REGION;
        if (!region)
            throw new Error("AWS_REGION is not set");
        const client = new client_secrets_manager_1.SecretsManagerClient({
            region,
        });
        let response;
        try {
            response = yield client.send(new client_secrets_manager_1.GetSecretValueCommand({
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
        const keypair = web3_js_1.Keypair.generate();
        return keypair;
    });
}
function main(useAWS) {
    return __awaiter(this, void 0, void 0, function* () {
        // Initialize connnection
        const RPC_URL = process.env.RPC_URL;
        if (!RPC_URL)
            throw new Error("RPC_URL is not set");
        const connection = new web3_js_1.Connection(RPC_URL);
        // Initialize wallet
        const keypair = useAWS
            ? yield fetchAWSSecretManagerService()
            : yield (0, helpers_1.getKeypairFromEnvironment)("SECRET_KEY");
        const wallet = new anchor_1.Wallet(keypair);
        // Initialize program
        const provider = new anchor_1.AnchorProvider(connection, wallet, { commitment: "confirmed" });
        (0, anchor_1.setProvider)(provider);
        const program = new anchor_1.Program(funds_program_json_1.default, constants_js_1.QUARTZ_PROGRAM_ID, provider);
        // Initialize AutoRepayBot
        const maxRetries = 3;
        const autoRepayBot = new autoRepayBot_js_1.AutoRepayBot(connection, wallet, program, maxRetries);
        autoRepayBot.run();
    });
}
dotenv_1.default.config();
const useAWS = (process.env.USE_AWS === "true");
main(useAWS);
