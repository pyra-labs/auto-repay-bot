import "dotenv/config";
import { getKeypairFromEnvironment } from "@solana-developers/helpers";
import { Connection, LAMPORTS_PER_SOL, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { AnchorProvider, BN, Idl, Program, setProvider, Wallet } from "@coral-xyz/anchor";
import quartzIdl from "../idl/funds_program.json";
import { FundsProgram } from "../idl/funds_program";
import { DRIFT_MARKET_INDEX_SOL, DRIFT_ORACLE_1, DRIFT_ORACLE_2, DRIFT_PROGRAM_ID, DRIFT_SPOT_MARKET_SOL, QUARTZ_ADDRESS_TABLE, QUARTZ_PROGRAM_ID, USDC_MINT, WSOL_MINT, DRIFT_SPOT_MARKET_USDC, DRIFT_MARKET_INDEX_USDC, DRIFT_SIGNER } from "./constants";
import { getDriftSpotMarketVault, getDriftState, getDriftUser, getDriftUserStats, getVault, getVaultSpl, toRemainingAccount } from "./helpers";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConfig as getMarginfiConfig, MarginfiClient } from "@mrgnlabs/marginfi-client-v2";
import { getJupiterSwapIx, getJupiterSwapQuote } from "./jupiter";
import { ASSOCIATED_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { PublicKey } from "@solana/web3.js";



// Initialize connnection and wallet
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("RPC_URL is not set");

const connection = new Connection(RPC_URL);
const keypair = getKeypairFromEnvironment("SECRET_KEY");
const wallet = new Wallet(keypair);

// Initialize program and required accounts
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
setProvider(provider);
const program = new Program(quartzIdl as Idl, QUARTZ_PROGRAM_ID, provider) as unknown as Program<FundsProgram>;

const quartzLookupTable = await connection.getAddressLookupTable(QUARTZ_ADDRESS_TABLE).then((res) => res.value);
if (!quartzLookupTable) throw Error("Address Lookup Table account not found");

const walletUsdc = await getAssociatedTokenAddress(USDC_MINT, keypair.publicKey);
const walletWSol = await getAssociatedTokenAddress(WSOL_MINT, keypair.publicKey);
// TODO - Throw an error if either ATA is not initialized

// Initiate Drift
const driftState = getDriftState();
const driftSpotMarketSol = getDriftSpotMarketVault(DRIFT_MARKET_INDEX_SOL);
const driftSpotMarketUsdc = getDriftSpotMarketVault(DRIFT_MARKET_INDEX_USDC);

// Initiate Marginfi
const marginfiClient = await MarginfiClient.fetch(getMarginfiConfig(), wallet, connection);
const flashLoanToken = "SOL";
const wsolBank = marginfiClient.getBankByTokenSymbol(flashLoanToken)?.address;
if (!wsolBank) throw Error(`${flashLoanToken} bank not found`);

const [ marginfiAccount ] = await marginfiClient.getMarginfiAccountsForAuthority(keypair.publicKey);
if (marginfiAccount === undefined) throw new Error("Flash loan MarginFi account not found");

// Initiate Pyth
const pythSolanaReceiver = new PythSolanaReceiver({ connection, wallet: wallet as Wallet });
const solUsdPriceFeedAccount = pythSolanaReceiver
    .getPriceFeedAccountAddress(0, "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d")
    .toBase58();
const usdcUsdPriceFeedAccount = pythSolanaReceiver
    .getPriceFeedAccountAddress(0, "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a")
    .toBase58();



export const executeTransaction = async (
    loanAmountBaseUnits: number,
    owner: PublicKey
) => {
    const vaultPda = getVault(owner);
    const vaultWsol = getVaultSpl(vaultPda, WSOL_MINT);
    const vaultUsdc = getVaultSpl(vaultPda, USDC_MINT);
    const driftUser = getDriftUser(vaultPda);
    const driftUserStats = getDriftUserStats(vaultPda);

    try {
        const preLoanBalancePromise = connection.getTokenAccountBalance(walletWSol).then(res => res.value.amount);
        const jupiterQuotePromise = getJupiterSwapQuote(WSOL_MINT, USDC_MINT, loanAmountBaseUnits);

        const [preLoanBalance, jupiterQuote] = await Promise.all([preLoanBalancePromise, jupiterQuotePromise]);
        const amountLamports = Number(jupiterQuote.inAmount);
        const amountLamportsWithSlippage = amountLamports * (1.01);
        const walletWsolBalance = Number(preLoanBalance) + amountLamportsWithSlippage;

        const autoRepayStartPromise = program.methods
            .autoRepayStart(new BN(walletWsolBalance))
            .accounts({
                caller: keypair.publicKey,
                callerWithdrawSpl: walletWSol,
                withdrawMint: WSOL_MINT,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .instruction();

        const jupiterSwapPromise = getJupiterSwapIx(keypair.publicKey, connection, jupiterQuote);

        const autoRepayDepositPromise = program.methods
            .autoRepayDeposit(DRIFT_MARKET_INDEX_USDC)
            .accounts({
                vault: vaultPda,
                vaultSpl: vaultUsdc,
                owner: owner,
                // caller: keypair.publicKey,
                ownerSpl: walletUsdc,
                splMint: USDC_MINT,
                driftUser: driftUser,
                driftUserStats: driftUserStats,
                driftState: driftState,
                spotMarketVault: driftSpotMarketUsdc,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
                driftProgram: DRIFT_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .remainingAccounts([
                toRemainingAccount(DRIFT_ORACLE_2, false, false),
                toRemainingAccount(DRIFT_ORACLE_1, false, false),
                toRemainingAccount(DRIFT_SPOT_MARKET_SOL, true, false),
                toRemainingAccount(DRIFT_SPOT_MARKET_USDC, true, false)
            ])
            .instruction();

        const autoRepayWithdrawPromise = program.methods
            .autoRepayWithdraw(DRIFT_MARKET_INDEX_SOL)
            .accounts({
                vault: vaultPda,
                vaultSpl: vaultWsol,
                owner: owner,
                // caller: keypair.publicKey,
                ownerSpl: walletWSol,
                splMint: WSOL_MINT,
                driftUser: driftUser,
                driftUserStats: driftUserStats,
                driftState: driftState,
                spotMarketVault: driftSpotMarketSol,
                driftSigner: DRIFT_SIGNER,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
                driftProgram: DRIFT_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                depositPriceUpdate: usdcUsdPriceFeedAccount,
                withdrawPriceUpdate: solUsdPriceFeedAccount,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .remainingAccounts([
                toRemainingAccount(DRIFT_ORACLE_2, false, false),
                toRemainingAccount(DRIFT_ORACLE_1, false, false),
                toRemainingAccount(DRIFT_SPOT_MARKET_SOL, true, false),
                toRemainingAccount(DRIFT_SPOT_MARKET_USDC, false, false)
            ])
            .instruction();

        const [
            ix_autoRepayStart, 
            jupiterSwap, 
            ix_autoRepayDeposit, 
            ix_autoRepayWithdraw
        ] = await Promise.all([autoRepayStartPromise, jupiterSwapPromise, autoRepayDepositPromise, autoRepayWithdrawPromise]);
        const {ix_jupiterSwap, jupiterLookupTables} = jupiterSwap;

        const amountSolUi = amountLamports / LAMPORTS_PER_SOL;
        const { flashloanTx } = await marginfiAccount.makeLoopTx(
            amountSolUi,
            amountSolUi,
            wsolBank,
            wsolBank,
            [ix_autoRepayStart, ix_jupiterSwap, ix_autoRepayDeposit, ix_autoRepayWithdraw],
            [quartzLookupTable, ...jupiterLookupTables],
            0.002,
            false
        );

        const signedTx = await wallet.signTransaction(flashloanTx);
        const signature = await connection.sendRawTransaction(signedTx.serialize());
        console.log(`Executed auto-repay for ${owner}, signature: ${signature}`);
        return signature;
    } catch (error) {
        console.error(error);
        // TODO - Alert admins if an error occurs
        return null;
    }
}