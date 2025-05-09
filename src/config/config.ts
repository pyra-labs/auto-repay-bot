import { bs58 } from '@quartz-labs/sdk';
import { Keypair } from '@solana/web3.js';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    LIQUIDATOR_KEYPAIR: z.string()
        .transform((str) => {
            try {
                return Keypair.fromSecretKey(bs58.decode(str));
            } catch (error) {
                console.error(error);
                throw new Error("Invalid LIQUIDATOR_KEYPAIR: must be a valid base58-encoded Solana private key");
            }
        }),
    RPC_URLS: z.string()
        .transform((str) => {
            try {
                const urls = str.split(',').map(url => url.trim());
                if (!urls.every(url => url.startsWith("https"))) throw new Error();
                return urls;
            } catch {
                throw new Error("Invalid RPC_URLS format: must be comma-separated URLs starting with https");
            }
        }),
});

const config = envSchema.parse(process.env);
export default config;
