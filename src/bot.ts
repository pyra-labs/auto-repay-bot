import { AnchorProvider, BN, Idl, Program, ProgramAccount, setProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DriftClient, fetchUserAccountsUsingKeys, OracleSource, UserAccount, ZERO } from "@drift-labs/sdk";
import { AddressLookupTableAccount } from "@solana/web3.js";
import { getConfig as getMarginfiConfig, MarginfiAccountWrapper, MarginfiClient } from "@mrgnlabs/marginfi-client-v2";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DRIFT_MARKET_INDEX_SOL, DRIFT_MARKET_INDEX_USDC, DRIFT_SPOT_MARKET_USDC, DRIFT_SPOT_MARKET_SOL, DRIFT_ORACLE_1, DRIFT_ORACLE_2, DRIFT_PROGRAM_ID, USDC_MINT, WSOL_MINT, DRIFT_SIGNER, QUARTZ_ADDRESS_TABLE, USER_ACCOUNT_SIZE, QUARTZ_HEALTH_BUFFER_PERCENTAGE, MAX_AUTO_REPAY_ATTEMPTS, QUARTZ_PROGRAM_ID, LOOP_DELAY, SUPPORTED_DRIFT_MARKETS, JUPITER_SLIPPAGE_BPS, MIN_LAMPORTS_BALANCE, GOAL_HEALTH, DRIFT_SOL_LIABILITY_WEIGHT } from "./config/constants.js";
import { getDriftState, toRemainingAccount, getDriftUserStats, getDriftUser, getVaultSpl, getVault, retryRPCWithBackoff, getQuartzHealth, createPriorityFeeInstructions, calculateRepayAmount } from "./utils/helpers.js";
import { getDriftSpotMarketVault } from "./utils/helpers.js";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { getJupiterSwapIx, getJupiterSwapQuote } from "./utils/jupiter.js";
import BigNumber from "bignumber.js";
import { DriftUser } from "./models/driftUser.js";
import { AppLogger } from "./utils/logger.js";
import config from "./config/config.js";
import quartzIdl from "./idl/quartz.json";
import { Quartz } from "./types/quartz.js";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export class AutoRepayBot extends AppLogger {
    private initPromise: Promise<void>;

    private connection: Connection;
    private wallet: Wallet | undefined;
    private program: Program<Quartz> | undefined;
    
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
            if (!config.WALLET_KEYPAIR) throw new Error("Wallet keypair is not set");
            this.wallet = new Wallet(Keypair.fromSecretKey(config.WALLET_KEYPAIR));
            return;
        }

        if (!config.AWS_REGION || !config.AWS_SECRET_NAME) throw new Error("AWS credentials are not set");

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
        this.program = new Program(quartzIdl as Idl, QUARTZ_PROGRAM_ID, provider) as unknown as Program<Quartz>;

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
            userStats: false,
            perpMarketIndexes: [],
            spotMarketIndexes: SUPPORTED_DRIFT_MARKETS,
            accountSubscription: {
                type: 'websocket',
                commitment: "confirmed"
            }
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
        
        setInterval(() => {
            this.logger.info(`Heartbeat | Bot address: ${this.wallet?.publicKey}`);
        }, 1000 * 60 * 60 * 24);

        while (true) {
            const vaults = await this.getAllVaults();
            try {
                const driftUsers = await retryRPCWithBackoff(
                    async () => this.fetchDriftUsers(vaults),
                    3,
                    1_000,
                    this.logger
                );
                
                for (let i = 0; i < vaults.length; i++) {
                    const vaultAddress = vaults[i].publicKey;
                    const owner = vaults[i].account.owner;
                    
                    const driftUser = new DriftUser(vaultAddress, this.connection, this.driftClient!, driftUsers[i]);
                    const driftHealth = driftUser.getHealth();
                    const quartzHealth = getQuartzHealth(driftHealth);

                    if (quartzHealth == 0) {
                        const usdcBalance = driftUser.getTokenAmount(DRIFT_MARKET_INDEX_USDC);
                        if (usdcBalance.gte(ZERO)) {
                            this.logger.error(`[${this.wallet?.publicKey}] Attempted to execute auto-repay on account ${owner} but found no outstanding loans`);
                            continue;
                        }

                        const loanAmount = Math.abs(usdcBalance.toNumber());
                        const repayAmount = calculateRepayAmount(
                            GOAL_HEALTH,
                            loanAmount,
                            driftUser.getTokenAmount(DRIFT_MARKET_INDEX_SOL).toNumber(),
                            DRIFT_SOL_LIABILITY_WEIGHT
                        );

                        // Note, because the value is in USDC, not further calculations are required for USDC loans.
                        // If the loan is another asset, repayAmount will need to be converted from its value into the actual amount.
                        this.attemptAutoRepay(vaultAddress, owner, repayAmount);
                    };
                }
            } catch (error) {
                this.logger.error(`[${this.wallet?.publicKey}] Error fetching Drift health: ${error}`);
            }

            await new Promise(resolve => setTimeout(resolve, LOOP_DELAY));
        }
    }

    private async getAllVaults(): Promise<ProgramAccount[]> {
        if (!this.program) throw new Error("Program is not initialized");

        return await retryRPCWithBackoff(
            async () => this.program!.account.vault.all(),
            3,
            1_000,
            this.logger
        );
    }

    private async fetchDriftUsers(vaults: ProgramAccount[]): Promise<UserAccount[]> {
        const driftUsers = await fetchUserAccountsUsingKeys(
            this.connection, 
            this.driftClient!.program, 
            vaults.map((vault) => getDriftUser(vault.publicKey))
        );
        
        const undefinedIndex = driftUsers.findIndex(user => !user);
        if (undefinedIndex !== -1) {
            throw new Error(`[${this.wallet?.publicKey}] Failed to fetch drift user for vault ${vaults[undefinedIndex].publicKey.toString()}`);
        }

        return driftUsers as UserAccount[];
    }

    private async attemptAutoRepay(
        vaultAddress: PublicKey, 
        owner: PublicKey, 
        repayAmount: number
    ): Promise<void> {
        for (let retry = 0; retry < MAX_AUTO_REPAY_ATTEMPTS; retry++) {
            try {
                const signature = await this.executeAutoRepay(vaultAddress, owner, repayAmount);

                const latestBlockhash = await this.connection.getLatestBlockhash();
                await this.connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

                this.logger.info(`Executed auto-repay for ${owner}, signature: ${signature}`);
                return;
            } catch (error) {
                this.logger.error(`[${this.wallet?.publicKey}] Auto-repay transaction failed for ${owner}, retrying... Error: ${error}`);
                continue;
            }
        }

        this.logger.error(`[${this.wallet?.publicKey}] Failed to execute auto-repay for ${owner}`);
    }

    private async executeAutoRepay (
        vault: PublicKey,
        owner: PublicKey,
        repayAmount: number
    ): Promise<string> {
        if (!this.program || !this.wallet || !this.walletWSol) throw new Error("AutoRepayBot is not initialized");

        const vaultWsol = getVaultSpl(vault, WSOL_MINT);
        const vaultUsdc = getVaultSpl(vault, USDC_MINT);
        const driftUser = getDriftUser(vault);
        const driftUserStats = getDriftUserStats(vault);

        const jupiterQuotePromise = getJupiterSwapQuote(WSOL_MINT, USDC_MINT, repayAmount, JUPITER_SLIPPAGE_BPS);
        const startingWSolBalancePromise = this.connection.getTokenAccountBalance(this.walletWSol)
            .then(res => Number(res.value.amount));
        const startingLamportsBalancePromise = this.connection.getBalance(this.wallet.publicKey);

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

        const [
            startingLamportsBalance, 
            startingWSolBalance, 
            jupiterQuote
        ] = await Promise.all([startingLamportsBalancePromise, startingWSolBalancePromise, jupiterQuotePromise]);
        const jupiterSwapPromise = getJupiterSwapIx(this.wallet.publicKey, this.connection, jupiterQuote);

        // Calculate balance amounts and wrap any wSOL needed
        const requiredSol = Math.round(
            Number(jupiterQuote.inAmount) * (1 + (JUPITER_SLIPPAGE_BPS / 10000))
        );
        const wrappableSol = startingLamportsBalance - MIN_LAMPORTS_BALANCE;
        const lamportsToBorrow = Math.max(0, requiredSol - wrappableSol - startingWSolBalance);
        const lamportsToWrap = Math.max(0, requiredSol - lamportsToBorrow - startingWSolBalance);

        const oix_wrapSol: TransactionInstruction[] = [];
        if (lamportsToWrap > 0) {
            oix_wrapSol.push(SystemProgram.transfer({
                fromPubkey: this.wallet.publicKey,
                toPubkey: this.walletWSol,
                lamports: lamportsToWrap
            }));
        }

        const autoRepayStartPromise = this.program.methods
            .autoRepayStart(new BN(startingWSolBalance + lamportsToWrap))
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

        const tx = await this.buildAutoRepayTx(
            lamportsToBorrow,
            [...oix_wrapSol, ix_autoRepayStart, ix_jupiterSwap, ix_autoRepayDeposit, ix_autoRepayWithdraw], 
            [this.quartzLookupTable!, ...jupiterLookupTables]
        );
        
        const signedTx = await this.wallet.signTransaction(tx);
        const signature = await this.connection.sendRawTransaction(signedTx.serialize());
        return signature;
    }

    private async buildAutoRepayTx(
        lamportsLoan: number,
        instructions: TransactionInstruction[],
        lookupTables: AddressLookupTableAccount[]
    ): Promise<VersionedTransaction> {
        if (!this.wallet || !this.walletWSol) throw new Error("AutoRepayBot is not initialized");

        if (lamportsLoan > 0) {
            const amountSolUi = new BigNumber(lamportsLoan).div(LAMPORTS_PER_SOL);
            const loop = await this.marginfiAccount!.makeLoopTx(
                amountSolUi,
                amountSolUi,
                this.wSolBank!,
                this.wSolBank!,
                instructions,
                lookupTables,
                0.002,
                false
            );
            return loop.flashloanTx;
        }

        // If no loan required, build regular tx
        const computeBudget = 200_000;
        const ix_priority = await createPriorityFeeInstructions(computeBudget);
        instructions.unshift(...ix_priority);

        const latestBlockhash = await this.connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: instructions,
        }).compileToV0Message();
        return new VersionedTransaction(messageV0);
    }
}
