"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toRemainingAccount = exports.getDriftSpotMarketVault = exports.getDriftState = exports.getDriftUserStats = exports.getDriftUser = exports.getVaultSpl = exports.getVault = void 0;
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const constants_js_1 = require("./constants.js");
const getVault = (owner) => {
    const [vault] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], constants_js_1.QUARTZ_PROGRAM_ID);
    return vault;
};
exports.getVault = getVault;
const getVaultSpl = (vaultPda, mint) => {
    const [vaultWSol] = web3_js_1.PublicKey.findProgramAddressSync([vaultPda.toBuffer(), mint.toBuffer()], constants_js_1.QUARTZ_PROGRAM_ID);
    return vaultWSol;
};
exports.getVaultSpl = getVaultSpl;
const getDriftUser = (authority) => {
    const [userPda] = web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("user"),
        authority.toBuffer(),
        new anchor_1.BN(0).toArrayLike(Buffer, 'le', 2),
    ], constants_js_1.DRIFT_PROGRAM_ID);
    return userPda;
};
exports.getDriftUser = getDriftUser;
const getDriftUserStats = (authority) => {
    const [userStatsPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("user_stats"), authority.toBuffer()], constants_js_1.DRIFT_PROGRAM_ID);
    return userStatsPda;
};
exports.getDriftUserStats = getDriftUserStats;
const getDriftState = () => {
    const [statePda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("drift_state")], constants_js_1.DRIFT_PROGRAM_ID);
    return statePda;
};
exports.getDriftState = getDriftState;
const getDriftSpotMarketVault = (marketIndex) => {
    const [spotMarketVaultPda] = web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("spot_market_vault"),
        new anchor_1.BN(marketIndex).toArrayLike(Buffer, 'le', 2)
    ], constants_js_1.DRIFT_PROGRAM_ID);
    return spotMarketVaultPda;
};
exports.getDriftSpotMarketVault = getDriftSpotMarketVault;
const toRemainingAccount = (pubkey, isWritable, isSigner) => {
    return { pubkey, isWritable, isSigner };
};
exports.toRemainingAccount = toRemainingAccount;
