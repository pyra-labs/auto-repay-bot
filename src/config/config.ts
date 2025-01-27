import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
    WALLET_KEYPAIR: z.string()
        .optional()
        .default("")
        .transform((str) => {
            if (!str.trim()) return null;
            try {
                const numbers = JSON.parse(str);
                if (!Array.isArray(numbers) || !numbers.every((n) => typeof n === 'number')) {
                    throw new Error();
                }
                return new Uint8Array(numbers);
            } catch {
                throw new Error("Invalid keypair format: must be a JSON array of numbers");
            }
        })
        .refine((bytes) => bytes === null || bytes.length === 64, 
            {message: "Keypair must be 64 bytes long"}
        ),
    RPC_URL: z.string().url(),
    USE_AWS: z.string().transform((str) => str === "true"),
    AWS_SECRET_NAME: z.string().nullable(),
    AWS_REGION: z.string().nullable()
});

const config = envSchema.parse({
    WALLET_KEYPAIR: process.env.WALLET_KEYPAIR,
    RPC_URL: process.env.RPC_URL,
    USE_AWS: process.env.USE_AWS,
    AWS_SECRET_NAME: process.env.AWS_SECRET_NAME,
    AWS_REGION: process.env.AWS_REGION
});
export default config;
