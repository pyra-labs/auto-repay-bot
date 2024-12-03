import { BN } from "@coral-xyz/anchor";
import { Connection, ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { DRIFT_PROGRAM_ID, QUARTZ_HEALTH_BUFFER_PERCENTAGE, QUARTZ_PROGRAM_ID } from "../config/constants.js";
import { Logger } from "winston";
import { createAssociatedTokenAccountInstruction } from "@solana/spl-token";

export const getVault = (owner: PublicKey) => {
    const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.toBuffer()],
        QUARTZ_PROGRAM_ID
    )
    return vault;
}

export const getVaultSpl = (vaultPda: PublicKey, mint: PublicKey) => {
    const [vaultWSol] = PublicKey.findProgramAddressSync(
        [vaultPda.toBuffer(), mint.toBuffer()],
        QUARTZ_PROGRAM_ID
    );
    return vaultWSol;
}

export const getDriftUser = (authority: PublicKey) => {
    const [userPda] = PublicKey.findProgramAddressSync(
        [
			Buffer.from("user"),
			authority.toBuffer(),
			new BN(0).toArrayLike(Buffer, 'le', 2),
		],
		DRIFT_PROGRAM_ID
    );
    return userPda;
}

export const getDriftUserStats = (authority: PublicKey) => {
    const [userStatsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_stats"), authority.toBuffer()],
        DRIFT_PROGRAM_ID
    );
    return userStatsPda;
}

export const getDriftState = () => {
    const [statePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("drift_state")],
        DRIFT_PROGRAM_ID
    );
    return statePda; 
}

export const getDriftSpotMarketVault = (marketIndex: number) => {
    const [spotMarketVaultPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("spot_market_vault"), 
            new BN(marketIndex).toArrayLike(Buffer, 'le', 2)    
        ],
        DRIFT_PROGRAM_ID
    );
    return spotMarketVaultPda;
}

export const toRemainingAccount = (
    pubkey: PublicKey, 
    isWritable: boolean, 
    isSigner: boolean
) => {
    return { pubkey, isWritable, isSigner }
}

export const retryRPCWithBackoff = async <T>(
    fn: () => Promise<T>,
    retries: number,
    initialDelay: number,
    logger?: Logger
): Promise<T> => {
    let lastError: any;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            if (error?.message?.includes('503')) {
                const delay = initialDelay * Math.pow(2, i);
                if (logger) logger.warn(`RPC node unavailable, retrying in ${delay}ms...`);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

export const getQuartzHealth = (driftHealth: number): number => {
    if (driftHealth <= 0) return 0;
    if (driftHealth >= 100) return 100;

    return Math.floor(
        Math.min(
            100,
            Math.max(
                0,
                (driftHealth - QUARTZ_HEALTH_BUFFER_PERCENTAGE) / (1 - (QUARTZ_HEALTH_BUFFER_PERCENTAGE / 100))
            )
        )
    );
}

export const createPriorityFeeInstructions = async (computeBudget: number) => {
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: computeBudget,
    });
    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: await 1_000_000 // TODO: Implement fetching priority fee
    });
    return [computeLimitIx, computePriceIx];
}

export const calculateRepayAmount = (
    goalHealth: number, // In decimal format
    loanValue: number, 
    currentWeightedCollateral: number,
    repayCollateralWeight: number, // In decimal format
    quartzHealthBuffer: number, // In decimal format
) => {
    // New Quartz health after repayment is given as:
    // 
    //                                      loanValue - repayAmount                     
    //             1 - ----------------------------------------------------------------- - quartzHealthBuffer
    //                 currentWeightedCollateral - (repayAmount * repayCollateralWeight)
    //   health = -------------------------------------------------------------------------------------------
    //                                               1 - quartzHealthBuffer                                  
    //
    // The following is an algebraicly simplified expression of the above formula, in terms of repayAmount

    return Math.round(
        (
            loanValue - currentWeightedCollateral * (1 - quartzHealthBuffer) * (1 - goalHealth)
        ) / (
            1 - repayCollateralWeight * (1 - quartzHealthBuffer) * (1 - goalHealth)
        )
    );
}

export async function createAtaIfNeeded(
    connection: Connection,
    ata: PublicKey,
    authority: PublicKey,
    mint: PublicKey
) {
    const oix_createAta: TransactionInstruction[] = [];
    const ataInfo = await connection.getAccountInfo(ata);
    if (ataInfo === null) {
        oix_createAta.push(
            createAssociatedTokenAccountInstruction(
                authority,
                ata,
                authority,
                mint
            )
        );
    }
    return oix_createAta;
}

export async function getTokenAccountBalance(connection: Connection, tokenAccount: PublicKey) {
    try {
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        return Number(balance.value.amount);
    } catch (error) {
        return 0;
    }
}
