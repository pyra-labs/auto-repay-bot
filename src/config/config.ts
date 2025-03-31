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
            } catch {
                throw new Error("Invalid LIQUIDATOR_KEYPAIR: must be a valid base58-encoded Solana private key");
            }
        }),
    RPC_URL: z.string().url()
});

const config = envSchema.parse(process.env);
export default config;
