import { AnchorProvider, BN, Idl, Program, ProgramAccount, setProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { DriftClient, ZERO } from "@drift-labs/sdk";
import { AddressLookupTableAccount } from "@solana/web3.js";
import { getConfig as getMarginfiConfig, MarginfiAccountWrapper, MarginfiClient } from "@mrgnlabs/marginfi-client-v2";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DRIFT_MARKET_INDEX_SOL, DRIFT_MARKET_INDEX_USDC, DRIFT_SPOT_MARKET_USDC, DRIFT_SPOT_MARKET_SOL, DRIFT_ORACLE_1, DRIFT_ORACLE_2, DRIFT_PROGRAM_ID, USDC_MINT, WSOL_MINT, DRIFT_SIGNER, QUARTZ_ADDRESS_TABLE, USER_ACCOUNT_SIZE, QUARTZ_HEALTH_BUFFER_PERCENTAGE, MAX_AUTO_REPAY_ATTEMPTS, QUARTZ_PROGRAM_ID, LOOP_DELAY } from "./config/constants.js";
import { getDriftState, toRemainingAccount, getDriftUserStats, getDriftUser, getVaultSpl, getVault, retryRPCWithBackoff, getQuartzHealth } from "./utils/helpers.js";
import { getDriftSpotMarketVault } from "./utils/helpers.js";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { getJupiterSwapIx, getJupiterSwapQuote } from "./utils/jupiter.js";
import BigNumber from "bignumber.js";
import { DriftUser } from "./models/driftUser.js";
import { AppLogger } from "./utils/logger.js";
import config from "./config/config.js";
import quartzIdl from "./idl/funds_program.json";
import { FundsProgram } from "./idl/funds_program.js";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export class AutoRepayBot extends AppLogger {
    private initPromise: Promise<void>;

    private connection: Connection;
    private wallet: Wallet | undefined;
    private program: Program<FundsProgram> | undefined;
    
    private quartzLookupTable: AddressLookupTableAccount | undefined;
    private walletUsdc: PublicKey | undefined;
    private walletWSol: PublicKey | undefined;

    private driftClient: DriftClient | undefined;
    private driftState: PublicKey = getDriftState();
    private driftSpotMarketSol: PublicKey = getDriftSpotMarketVault(DRIFT_MARKET_INDEX_SOL);
    private driftSpotMarketUsdc: PublicKey = getDriftSpotMarketVault(DRIFT_MARKET_INDEX_USDC);

    private marginfiAccount: MarginfiAccountWrapper | undefined;
    private wSolBank: PublicKey | undefined;

    private pythSolanaReceiver: PythSolanaReceiver | undefined;
    private solUsdPriceFeedAccount: PublicKey | undefined;
    private usdcUsdPriceFeedAccount: PublicKey | undefined;

    constructor() {
        super("Auto-Repay Bot");

        this.connection = new Connection(config.RPC_URL);
        this.initPromise = this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.initWallet(),
        await this.initProgram(),
        await this.initATAs(),
        await this.initIntegrations()
    }

    private async initWallet(): Promise<void> {
        if (!config.USE_AWS) {
            this.wallet = new Wallet(Keypair.fromSecretKey(config.WALLET_KEYPAIR));
            return;
        }

        const client = new SecretsManagerClient({ region: config.AWS_REGION });

        try {
            const response = await client.send(
                new GetSecretValueCommand({
                    SecretId: config.AWS_SECRET_NAME,
                    VersionStage: "AWSCURRENT",
                })
            );

            const secretString = response.SecretString;
            if (!secretString) throw new Error("Secret string is not set");

            const secret = JSON.parse(secretString);
            const secretArray = new Uint8Array(JSON.parse(secret.liquidatorSecret));

            this.wallet = new Wallet(Keypair.fromSecretKey(secretArray));
        } catch (error) {
            throw new Error(`Failed to get secret key from AWS: ${error}`);
        }
    }

    private async initProgram(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        const provider = new AnchorProvider(this.connection, this.wallet, { commitment: "confirmed" });
        setProvider(provider);
        this.program = new Program(quartzIdl as Idl, QUARTZ_PROGRAM_ID, provider) as unknown as Program<FundsProgram>;

        const quartzLookupTable = await this.connection.getAddressLookupTable(QUARTZ_ADDRESS_TABLE).then((res) => res.value);
        if (!quartzLookupTable) throw Error("Address Lookup Table account not found");
        this.quartzLookupTable = quartzLookupTable;
    }

    private async initATAs(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        this.walletUsdc = await getOrCreateAssociatedTokenAccount(
            this.connection,
            this.wallet.payer,
            USDC_MINT,
            this.wallet.publicKey
        ).then((account) => account.address);
        this.walletWSol = await getOrCreateAssociatedTokenAccount(
            this.connection,
            this.wallet.payer,
            WSOL_MINT,
            this.wallet.publicKey
        ).then((account) => account.address);
    }

    private async initIntegrations(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        // Drift
        this.driftClient = new DriftClient({
            connection: this.connection,
            wallet: this.wallet,
            env: 'mainnet-beta',
        });
        await this.driftClient.subscribe();

        // MarginFi
        const flashLoanToken = "SOL";
        const marginfiClient = await MarginfiClient.fetch(getMarginfiConfig(), this.wallet, this.connection);
        const wSolBank = marginfiClient.getBankByTokenSymbol(flashLoanToken)?.address;
        if (!wSolBank) throw Error(`${flashLoanToken} bank not found`);
        this.wSolBank = wSolBank;

        const marginfiAccounts = await marginfiClient.getMarginfiAccountsForAuthority(this.wallet.publicKey);
        if (marginfiAccounts.length === 0) {
            this.marginfiAccount = await marginfiClient.createMarginfiAccount();
        } else {
            this.marginfiAccount = marginfiAccounts[0];
        }

        // Pyth
        this.pythSolanaReceiver = new PythSolanaReceiver({ connection: this.connection, wallet: this.wallet });
        this.solUsdPriceFeedAccount = this.pythSolanaReceiver
            .getPriceFeedAccountAddress(0, "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");
        this.usdcUsdPriceFeedAccount = this.pythSolanaReceiver
            .getPriceFeedAccountAddress(0, "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a");
    }

    async start(): Promise<void> {
        await this.initPromise;
        this.logger.info(`Auto-Repay Bot initialized with address ${this.wallet?.publicKey}`);

        while (true) {
            const vaults = await this.getAllVaults();
            const now = new Date();
            this.logger.info(`[${now.toISOString()}] Checking ${vaults.length} vaults...`);

            for (const vault of vaults) {
                const vaultAddress = vault.publicKey;
                const owner = vault.account.owner;
                try {
                    const driftUser = new DriftUser(vaultAddress, this.connection, this.driftClient!);
                    await retryRPCWithBackoff(
                        async () => driftUser.initialize(),
                        3,
                        1_000,
                        this.logger
                    );

                    const driftHealth = driftUser.getHealth();
                    const quartzHealth = getQuartzHealth(driftHealth);

                    if (quartzHealth == 0) {
                        this.attemptAutoRepay(vaultAddress, owner, driftUser);
                    };
                } catch (error) {
                    this.logger.error(`Error finding Drift User for ${vault.account.owner}: ${error}`);
                }
            }

            await new Promise(resolve => setTimeout(resolve, LOOP_DELAY));
        }
    }

    private async getAllVaults(): Promise<ProgramAccount[]> {
        if (!this.program) throw new Error("Program is not initialized");

        return await retryRPCWithBackoff(
            async () => {
                return await this.program!.account.vault.all();
            },
            3,
            1_000,
            this.logger
        );
    }

    private async attemptAutoRepay(
        vaultAddress: PublicKey, 
        owner: PublicKey, 
        driftUser: DriftUser
    ): Promise<void> {
        for (let retry = 0; retry < MAX_AUTO_REPAY_ATTEMPTS; retry++) {
            try {
                const usdcBalance = driftUser.getTokenAmount(DRIFT_MARKET_INDEX_USDC);
                if (usdcBalance.gte(ZERO)) {
                    this.logger.error("Attempted to execute auto-repay on low health account but found no outstanding loans");
                    return;
                }

                const loanAmount = Math.abs(usdcBalance.toNumber());
                const signature = await this.executeAutoRepay(vaultAddress, owner, loanAmount);

                const latestBlockhash = await this.connection.getLatestBlockhash();
                await this.connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

                this.logger.info(`Executed auto-repay for ${owner}, signature: ${signature}`);
                return;
            } catch (error) {
                this.logger.error(`Auto-repay transaction failed for ${owner}, retrying... Error: ${error}`);
                continue;
            }
        }

        this.logger.error(`Failed to execute auto-repay for ${owner}`);
    }

    private async executeAutoRepay (
        vault: PublicKey,
        owner: PublicKey,
        loanAmountBaseUnits: number
    ): Promise<string> {
        if (!this.program || !this.wallet) throw new Error("AutoRepayBot is not initialized");

        const vaultWsol = getVaultSpl(vault, WSOL_MINT);
        const vaultUsdc = getVaultSpl(vault, USDC_MINT);
        const driftUser = getDriftUser(vault);
        const driftUserStats = getDriftUserStats(vault);

        const jupiterQuotePromise = getJupiterSwapQuote(WSOL_MINT, USDC_MINT, loanAmountBaseUnits);
        const preLoanBalancePromise = this.connection.getTokenAccountBalance(this.walletWSol!).then(res => res.value.amount);

        const autoRepayDepositPromise = this.program.methods
            .autoRepayDeposit(DRIFT_MARKET_INDEX_USDC)
            .accounts({
                vault: vault,
                vaultSpl: vaultUsdc,
                owner: owner,
                caller: this.wallet.publicKey,
                callerSpl: this.walletUsdc,
                splMint: USDC_MINT,
                driftUser: driftUser,
                driftUserStats: driftUserStats,
                driftState: this.driftState,
                spotMarketVault: this.driftSpotMarketUsdc,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
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

        const autoRepayWithdrawPromise = this.program.methods
            .autoRepayWithdraw(DRIFT_MARKET_INDEX_SOL)
            .accounts({
                vault: vault,
                vaultSpl: vaultWsol,
                owner: owner,
                caller: this.wallet.publicKey,
                callerSpl: this.walletWSol,
                splMint: WSOL_MINT,
                driftUser: driftUser,
                driftUserStats: driftUserStats,
                driftState: this.driftState,
                spotMarketVault: this.driftSpotMarketSol,
                driftSigner: DRIFT_SIGNER,
                tokenProgram: TOKEN_PROGRAM_ID,
                driftProgram: DRIFT_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                depositPriceUpdate: this.usdcUsdPriceFeedAccount,
                withdrawPriceUpdate: this.solUsdPriceFeedAccount,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .remainingAccounts([
                toRemainingAccount(DRIFT_ORACLE_2, false, false),
                toRemainingAccount(DRIFT_ORACLE_1, false, false),
                toRemainingAccount(DRIFT_SPOT_MARKET_SOL, true, false),
                toRemainingAccount(DRIFT_SPOT_MARKET_USDC, false, false)
            ])
            .instruction();

        const [preLoanBalance, jupiterQuote] = await Promise.all([preLoanBalancePromise, jupiterQuotePromise]);
        const jupiterSwapPromise = getJupiterSwapIx(this.wallet.publicKey, this.connection, jupiterQuote);

        const amountLamports = Number(jupiterQuote.inAmount);
        const amountLamportsWithSlippage = Math.floor(amountLamports * (1.01));
        const walletWsolBalance = Number(preLoanBalance) + amountLamportsWithSlippage;

        const autoRepayStartPromise = this.program.methods
            .autoRepayStart(new BN(walletWsolBalance))
            .accounts({
                caller: this.wallet.publicKey,
                callerWithdrawSpl: this.walletWSol,
                withdrawMint: WSOL_MINT,
                vault: vault,
                vaultWithdrawSpl: vaultWsol,
                owner: owner,
                tokenProgram: TOKEN_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .instruction();

        const [
            ix_autoRepayStart, 
            jupiterSwap, 
            ix_autoRepayDeposit, 
            ix_autoRepayWithdraw
        ] = await Promise.all([autoRepayStartPromise, jupiterSwapPromise, autoRepayDepositPromise, autoRepayWithdrawPromise]);
        const {ix_jupiterSwap, jupiterLookupTables} = jupiterSwap;

        const amountSolUi = new BigNumber(amountLamportsWithSlippage).div(LAMPORTS_PER_SOL);
        const { flashloanTx } = await this.marginfiAccount!.makeLoopTx(
            amountSolUi,
            amountSolUi,
            this.wSolBank!,
            this.wSolBank!,
            [ix_autoRepayStart, ix_jupiterSwap, ix_autoRepayDeposit, ix_autoRepayWithdraw],
            [this.quartzLookupTable!, ...jupiterLookupTables],
            0.002,
            false
        );

        const signedTx = await this.wallet.signTransaction(flashloanTx);
        const signature = await this.connection.sendRawTransaction(signedTx.serialize());
        return signature;
    }
}