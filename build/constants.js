"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DRIFT_MARKET_INDEX_SOL = exports.DRIFT_MARKET_INDEX_USDC = exports.DRIFT_ORACLE_2 = exports.DRIFT_ORACLE_1 = exports.DRIFT_SPOT_MARKET_USDC = exports.DRIFT_SPOT_MARKET_SOL = exports.DRIFT_SIGNER = exports.DRIFT_PROGRAM_ID = exports.WSOL_MINT = exports.USDC_MINT = exports.QUARTZ_HEALTH_BUFFER_PERCENTAGE = exports.USER_ACCOUNT_SIZE = exports.QUARTZ_ADDRESS_TABLE = exports.QUARTZ_PROGRAM_ID = void 0;
const web3_js_1 = require("@solana/web3.js");
exports.QUARTZ_PROGRAM_ID = new web3_js_1.PublicKey("6JjHXLheGSNvvexgzMthEcgjkcirDrGduc3HAKB2P1v2");
exports.QUARTZ_ADDRESS_TABLE = new web3_js_1.PublicKey("96BmeKKVGX3LKYSKo3FCEom1YpNY11kCnGscKq6ouxLx");
exports.USER_ACCOUNT_SIZE = 8 + 32 + 1; // Discriminator + Pubkey + u8
exports.QUARTZ_HEALTH_BUFFER_PERCENTAGE = 10;
exports.USDC_MINT = new web3_js_1.PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
exports.WSOL_MINT = new web3_js_1.PublicKey("So11111111111111111111111111111111111111112");
exports.DRIFT_PROGRAM_ID = new web3_js_1.PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
exports.DRIFT_SIGNER = new web3_js_1.PublicKey("JCNCMFXo5M5qwUPg2Utu1u6YWp3MbygxqBsBeXXJfrw");
exports.DRIFT_SPOT_MARKET_SOL = new web3_js_1.PublicKey("3x85u7SWkmmr7YQGYhtjARgxwegTLJgkSLRprfXod6rh");
exports.DRIFT_SPOT_MARKET_USDC = new web3_js_1.PublicKey("6gMq3mRCKf8aP3ttTyYhuijVZ2LGi14oDsBbkgubfLB3");
exports.DRIFT_ORACLE_1 = new web3_js_1.PublicKey("BAtFj4kQttZRVep3UZS2aZRDixkGYgWsbqTBVDbnSsPF");
exports.DRIFT_ORACLE_2 = new web3_js_1.PublicKey("En8hkHLkRe9d9DraYmBTrus518BvmVH448YcvmrFM6Ce");
exports.DRIFT_MARKET_INDEX_USDC = 0;
exports.DRIFT_MARKET_INDEX_SOL = 1;
