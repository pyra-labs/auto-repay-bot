import { bs58 } from "@quartz-labs/sdk";
import { Keypair } from "@solana/web3.js";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
	LIQUIDATOR_KEYPAIR: z.string().transform((str) => {
		try {
			return Keypair.fromSecretKey(bs58.decode(str));
		} catch (error) {
			console.error(error);
			throw new Error(
				"Invalid LIQUIDATOR_KEYPAIR: must be a valid base58-encoded Solana private key",
			);
		}
	}),
	RPC_URLS: z.string().transform((str) => {
		try {
			const urls = str.split(",").map((url) => url.trim());
			if (urls.length === 0) throw new Error("No URLs found");

			const nonEmptyUrls = urls.filter((url) => url.length > 0);
			if (nonEmptyUrls.length === 0)
				throw new Error("No URLs found after filtering empty strings");

			const invalidUrls = nonEmptyUrls.filter(
				(url) => !url.startsWith("https"),
			);
			if (invalidUrls.length > 0) {
				throw new Error(`Invalid URLs found: ${invalidUrls.join(",")}`);
			}
			return nonEmptyUrls;
		} catch (error) {
			throw new Error(
				`RPC_URLS must be comma-separated URLs starting with https - ${error}`,
			);
		}
	}),
	INTERNAL_API_URL: z
		.string()
		.url()
		.transform((str) => str.replace(/\/+$/, "")),
});

const config = envSchema.parse(process.env);
export default config;
