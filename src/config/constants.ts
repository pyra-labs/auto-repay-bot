import { PublicKey } from "@solana/web3.js";

export const QUARTZ_PROGRAM_ID = new PublicKey("6JjHXLheGSNvvexgzMthEcgjkcirDrGduc3HAKB2P1v2");
export const QUARTZ_ADDRESS_TABLE = new PublicKey("96BmeKKVGX3LKYSKo3FCEom1YpNY11kCnGscKq6ouxLx");

export const MAX_AUTO_REPAY_ATTEMPTS = 3;

export const USER_ACCOUNT_SIZE = 8 + 32 + 1; // Discriminator + Pubkey + u8
export const QUARTZ_HEALTH_BUFFER_PERCENTAGE = 10;

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const DRIFT_PROGRAM_ID = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
export const DRIFT_SIGNER = new PublicKey("JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw");
export const DRIFT_SPOT_MARKET_SOL = new PublicKey("3x85u7SWkmmr7YQGYhtjARgxwegTLJgkSLRprfXod6rh");
export const DRIFT_SPOT_MARKET_USDC = new PublicKey("6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3");
export const DRIFT_ORACLE_1 = new PublicKey("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF");
export const DRIFT_ORACLE_2 = new PublicKey("En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce");
export const DRIFT_MARKET_INDEX_USDC = 0;
export const DRIFT_MARKET_INDEX_SOL = 1;