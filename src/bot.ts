import { Connection, Keypair, type PublicKey, SystemProgram, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { getConfig as getMarginfiConfig, type MarginfiAccountWrapper, MarginfiClient } from "@mrgnlabs/marginfi-client-v2";
import { createSyncNativeInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { MAX_AUTO_REPAY_ATTEMPTS, LOOP_DELAY, JUPITER_SLIPPAGE_BPS, MIN_LAMPORTS_BALANCE, GOAL_HEALTH } from "./config/constants.js";
import { retryRPCWithBackoff, createPriorityFeeInstructions, getTokenAccountBalance, getJupiterSwapQuote, getLowestValue, getHighestValue, getPrices } from "./utils/helpers.js";
import { AppLogger } from "./utils/logger.js";
import config from "./config/config.js";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getTokenProgram, MarketIndex, QuartzClient, type QuartzUser, TOKENS, makeCreateAtaIxIfNeeded, DummyWallet, WSOL_MINT, baseUnitToDecimal } from "@quartz-labs/sdk";

export class AutoRepayBot extends AppLogger {
    private initPromise: Promise<void>;

    private connection: Connection;
    private wallet: Keypair | undefined;
    private splWallets = {} as Record<MarketIndex, PublicKey>;

    private quartzClient: QuartzClient | undefined;
    private marginfiClient: MarginfiClient | undefined;
    private marginfiAccount: MarginfiAccountWrapper | undefined;

    constructor() {
        super("Auto-Repay Bot");

        this.connection = new Connection(config.RPC_URL);
        this.initPromise = this.initialize();
    }

    private async initialize(): Promise<void> {
        await this.initWallet();
        await this.initATAs();
        await this.initClients();
    }

    private async initWallet(): Promise<void> {
        if (!config.USE_AWS) {
            if (!config.WALLET_KEYPAIR) throw new Error("Wallet keypair is not set");
            this.wallet = Keypair.fromSecretKey(config.WALLET_KEYPAIR);
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

            this.wallet = Keypair.fromSecretKey(secretArray);
        } catch (error) {
            throw new Error(`Failed to get secret key from AWS: ${error}`);
        }
    }

    private async initATAs(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        const oix_createATAs = [];
        for (const [marketIndex, token] of Object.entries(TOKENS)) {
            const tokenProgram = await getTokenProgram(this.connection, token.mint);
            const ata = await getAssociatedTokenAddress(token.mint, this.wallet.publicKey, false, tokenProgram);

            const oix_createAta = await makeCreateAtaIxIfNeeded(this.connection, ata, this.wallet.publicKey, token.mint, tokenProgram);
            if (oix_createAta.length > 0) oix_createATAs.push(...oix_createAta);

            this.splWallets[Number(marketIndex) as MarketIndex] = ata;
        }
        if (oix_createATAs.length === 0) return;

        const computeBudget = 200_000;
        const ix_priority = await createPriorityFeeInstructions(computeBudget);
        oix_createATAs.unshift(...ix_priority);

        const latestBlockhash = await this.connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: oix_createATAs,
        }).compileToV0Message();
        const transaction = new VersionedTransaction(messageV0);

        transaction.sign([this.wallet]);
        const signature = await this.connection.sendRawTransaction(transaction.serialize());
        this.logger.info(`Created associated token accounts, signature: ${signature}`);
    }

    private async initClients(): Promise<void> {
        if (!this.wallet) throw new Error("Wallet is not initialized");

        this.quartzClient = await QuartzClient.fetchClient(this.connection);

        this.marginfiClient = await MarginfiClient.fetch(getMarginfiConfig(), new DummyWallet(this.wallet.publicKey), this.connection);
        const marginfiAccounts = await this.marginfiClient.getMarginfiAccountsForAuthority(this.wallet.publicKey);
        if (marginfiAccounts.length === 0) {
            this.marginfiAccount = await this.marginfiClient.createMarginfiAccount();
        } else {
            this.marginfiAccount = marginfiAccounts[0];
        }
    }

    async start(): Promise<void> {
        await this.initPromise;
        if (!this.wallet || !this.quartzClient) throw new Error("Could not initialize correctly");
        this.logger.info(`Auto-Repay Bot initialized with address ${this.wallet.publicKey}`);
        
        setInterval(() => {
            this.logger.info(`Heartbeat | Bot address: ${this.wallet?.publicKey}`);
        }, 1000 * 60 * 60 * 24);

        const prices = await getPrices();
        this.logger.info(`[${this.wallet?.publicKey}] Prices: ${JSON.stringify(prices)}`);

        while (true) {
            let owners: PublicKey[];
            let users: (QuartzUser | null)[];
            try {
                [owners, users] = await retryRPCWithBackoff(
                    async () => {
                        if (!this.quartzClient) throw new Error("Quartz client is not initialized");
                        const owners = await this.quartzClient.getAllQuartzAccountOwnerPubkeys();
                        const users = await this.quartzClient.getMultipleQuartzAccounts(owners);
                        return [owners, users];
                    },
                    3,
                    1_000,
                    this.logger
                );
            } catch (error) {
                this.logger.error(`[${this.wallet?.publicKey}] Error fetching users: ${error}`);
                continue;
            }
                
            for (let i = 0; i < owners.length; i++) {
                const user = users[i];
                try {
                    if (user === null || user === undefined) {
                        // this.logger.warn(`[${this.wallet?.publicKey}] Failed to fetch Quartz user for ${owners[i]?.toBase58()}`);
                        continue;
                    }

                    if (user.getHealth() === 0) {
                        const { 
                            repayAmountBaseUnits: repayAmount, 
                            marketIndexLoan,
                            marketIndexCollateral 
                        } = await this.fetchAutoRepayParams(user);
                        this.attemptAutoRepay(user, repayAmount, marketIndexLoan, marketIndexCollateral);
                    };
                } catch (error) {
                    this.logger.error(`[${this.wallet?.publicKey}] Error processing user: ${error}`);
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, LOOP_DELAY));
        }
    }

    private async fetchAutoRepayParams(user: QuartzUser): Promise<{
        repayAmountBaseUnits: number,
        marketIndexLoan: MarketIndex,
        marketIndexCollateral: MarketIndex
    }> {
        const balances = await user.getMultipleTokenBalances([...MarketIndex]);
        const prices = await getPrices();
        
        const values = Object.fromEntries(
            Object.entries(balances).map(([index, balance]) => [
                index,
                prices[Number(index) as MarketIndex] * balance.toNumber()
            ])
        ) as Record<MarketIndex, number>;

        const marketIndexLoan = getLowestValue(values);
        const marketIndexCollateral = getHighestValue(values);

        const repayValue = user.getRepayAmountForTargetHealth(
            GOAL_HEALTH, 
            TOKENS[marketIndexCollateral].driftCollateralWeight.toNumber()
        );

        const targetRepayAmount = repayValue / prices[marketIndexCollateral];
        const repayAmount = Math.max(targetRepayAmount, balances[marketIndexCollateral].toNumber());

        return {
            repayAmountBaseUnits: Math.floor(repayAmount),
            marketIndexLoan,
            marketIndexCollateral
        }
    }

    private async attemptAutoRepay(
        user: QuartzUser, 
        repayAmount: number,
        marketIndexLoan: MarketIndex,
        marketIndexCollateral: MarketIndex
    ): Promise<void> {
        let lastError: Error | null = null;
        for (let retry = 0; retry < MAX_AUTO_REPAY_ATTEMPTS; retry++) {
            try {
                const signature = await this.executeAutoRepay(
                    user, 
                    repayAmount, 
                    marketIndexLoan, 
                    marketIndexCollateral
                );

                const latestBlockhash = await this.connection.getLatestBlockhash();
                await this.connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");

                this.logger.info(`Executed auto-repay for ${user.pubkey.toBase58()}, signature: ${signature}`);
                return;
            } catch (error) {
                lastError = error as Error;
                this.logger.warn(
                    `[${this.wallet?.publicKey}] Auto-repay transaction failed for ${user.pubkey.toBase58()}, retrying... Error: ${error}`
                );
                
                const delay = 1_000 * (retry + 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        try {
            const refreshedUser = await this.quartzClient?.getQuartzAccount(user.pubkey);
            const refreshedHealth = refreshedUser?.getHealth();
            if (refreshedHealth === undefined || refreshedHealth === 0) throw lastError;
        } catch (error) {
            this.logger.error(`[${this.wallet?.publicKey}] Failed to execute auto-repay for ${user.pubkey.toBase58()}. Error: ${error}`);
        }
    }

    private async executeAutoRepay (
        user: QuartzUser,
        repayAmount: number,
        marketIndexLoan: MarketIndex,
        marketIndexCollateral: MarketIndex
    ): Promise<string> {
        if (!this.wallet || !this.splWallets[marketIndexLoan] || !this.splWallets[marketIndexCollateral]) {
            throw new Error("AutoRepayBot is not initialized");
        }

        // Fetch quote and balances
        const jupiterQuotePromise = getJupiterSwapQuote(
            TOKENS[marketIndexCollateral].mint, 
            TOKENS[marketIndexLoan].mint, 
            repayAmount, 
            JUPITER_SLIPPAGE_BPS
        );
        const startingCollateralBalancePromise = getTokenAccountBalance(this.connection, this.splWallets[marketIndexCollateral]);
        const startingLamportsBalancePromise = this.connection.getBalance(this.wallet.publicKey);

        const [
            startingLamportsBalance, 
            startingCollateralBalance, 
            jupiterQuote
        ] = await Promise.all([startingLamportsBalancePromise, startingCollateralBalancePromise, jupiterQuotePromise]);

        // Calculate balance amounts
        const requiredCollateralForRepay = Math.ceil(
            Number(jupiterQuote.inAmount) * (1 + (JUPITER_SLIPPAGE_BPS / 10000))
        );
        const amountExtraCollateralRequired = Math.max(0, requiredCollateralForRepay - startingCollateralBalance);

        // Wrap any SOL if needed
        let lamportsToWrap = 0;
        let oix_createWSolAta: TransactionInstruction[] = [];
        const oix_wrapSol: TransactionInstruction[] = [];
        if (TOKENS[marketIndexLoan].mint === WSOL_MINT) {
            oix_createWSolAta = await makeCreateAtaIxIfNeeded(
                this.connection, 
                this.splWallets[marketIndexLoan], 
                this.wallet.publicKey, 
                TOKENS[marketIndexLoan].mint, 
                TOKEN_PROGRAM_ID
            );
        } else if (TOKENS[marketIndexCollateral].mint === WSOL_MINT) {
            const wrappableLamports = Math.max(0, startingLamportsBalance - MIN_LAMPORTS_BALANCE);
            lamportsToWrap = Math.min(amountExtraCollateralRequired, wrappableLamports);

            oix_createWSolAta = await makeCreateAtaIxIfNeeded(
                this.connection, 
                this.splWallets[marketIndexCollateral], 
                this.wallet.publicKey, 
                TOKENS[marketIndexCollateral].mint, 
                TOKEN_PROGRAM_ID
            );
        }

        if (oix_createWSolAta.length > 0 && lamportsToWrap > 0) {
            oix_wrapSol.push(
                SystemProgram.transfer({
                    fromPubkey: this.wallet.publicKey,
                    toPubkey: this.splWallets[marketIndexCollateral],
                    lamports: lamportsToWrap
                }),
                createSyncNativeInstruction(this.splWallets[marketIndexCollateral])
            );
        }

        // Warning to keep gas funds balance
        if (startingLamportsBalance < MIN_LAMPORTS_BALANCE) {
            this.logger.error(`[${this.wallet?.publicKey}] Low SOL balance, please add more funds`);
        }

        // Build instructions
        const collateralToBorrow = Math.max(0, amountExtraCollateralRequired - lamportsToWrap);
        const startingBalance = startingCollateralBalance + lamportsToWrap + collateralToBorrow;
        const {ixs: ixs_autoRepay, lookupTables} = await user.makeCollateralRepayIxs(
            this.wallet.publicKey,
            marketIndexLoan,
            marketIndexCollateral,
            startingBalance,
            jupiterQuote
        )

        const instructions = [...oix_createWSolAta, ...oix_wrapSol, ...ixs_autoRepay];
        const transaction = await this.buildAutoRepayTx(
            collateralToBorrow,
            marketIndexCollateral,
            instructions, 
            lookupTables
        );

        transaction.sign([this.wallet]);
        const signature = await this.connection.sendRawTransaction(transaction.serialize());
        return signature;
    }

    private async buildAutoRepayTx(
        collateralToBorrow: number,
        marketIndexCollateral: MarketIndex,
        instructions: TransactionInstruction[],
        lookupTables: AddressLookupTableAccount[]
    ): Promise<VersionedTransaction> {
        if (!this.wallet || !this.marginfiAccount || !this.marginfiClient) {
            throw new Error("AutoRepayBot is not initialized");
        }

        if (collateralToBorrow > 0) {
            const amountCollateralDecimal = baseUnitToDecimal(collateralToBorrow, marketIndexCollateral);
            const collateralBank = await this.marginfiClient.getBankByMint(TOKENS[marketIndexCollateral].mint);
            if (!collateralBank) throw new Error("Collateral bank for flash loan not found");

            const loop = await this.marginfiAccount.makeLoopTx(
                amountCollateralDecimal,
                amountCollateralDecimal,
                collateralBank.address,
                collateralBank.address,
                instructions,
                lookupTables,
                0.002,
                false
            );
            return loop.flashloanTx;
        }

        // If no loan required, build regular tx
        const computeBudget = 700_000;
        const ix_priority = await createPriorityFeeInstructions(computeBudget);
        instructions.unshift(...ix_priority);

        const latestBlockhash = await this.connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: instructions
        }).compileToV0Message(lookupTables);
        return new VersionedTransaction(messageV0);
    }
}
