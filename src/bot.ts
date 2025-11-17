import {
	Keypair,
	PublicKey,
	SendTransactionError,
	SystemProgram,
	type VersionedTransaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import {
	createSyncNativeInstruction,
	getAssociatedTokenAddress,
	TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
	MAX_AUTO_REPAY_ATTEMPTS,
	LOOP_DELAY,
	MIN_LAMPORTS_BALANCE,
	GOAL_HEALTH,
	MIN_LOAN_VALUE_DOLLARS,
} from "./config/constants.js";
import {
	getTokenAccountBalance,
	getSortedPositions,
	fetchExactInParams,
	isSlippageError,
	getPrices,
	fetchExactOutParams,
} from "./utils/helpers.js";
import config from "./config/config.js";
import {
	MarketIndex,
	getTokenProgram,
	QuartzClient,
	type QuartzUser,
	TOKENS,
	makeCreateAtaIxIfNeeded,
	type BN,
	retryWithBackoff,
	MARKET_INDEX_SOL,
	decimalToBaseUnit,
	MARKET_INDEX_USDC,
	ZERO,
	buildTransaction,
	fetchAndParse,
	type WithdrawOrder,
	getMarketKeypair,
	baseUnitToDecimal,
} from "@quartz-labs/sdk";
import type { Position } from "./types/Position.interface.js";
import { AppLogger } from "@quartz-labs/logger";
import AdvancedConnection from "@quartz-labs/connection";
import { CollateralBelowMinimumError } from "./types/errors.js";
import type { UserDataResponse } from "./types/Vault.interface.js";
import { makeJupiterIx } from "./utils/jupiter.js";
import type { QuoteResponse } from "@jup-ag/api";
import { FlashLoanClient } from "./clients/FlashLoan.client.js";

export class AutoRepayBot extends AppLogger {
	private initPromise: Promise<void>;

	private connection: AdvancedConnection;
	private feePayer: Keypair;
	private splWallets = {} as Record<MarketIndex, PublicKey>;

	private quartzClient: QuartzClient | undefined;
	private flashLoanClient: FlashLoanClient;

	constructor() {
		super({
			name: "Auto-Repay Bot",
			dailyErrorCacheTimeMs: 1000 * 60 * 15, // 15 minutes
		});

		this.connection = new AdvancedConnection(config.RPC_URLS);
		this.feePayer = Keypair.fromSecretKey(config.LIQUIDATOR_KEYPAIR);

		this.initPromise = this.initialize();
		this.flashLoanClient = FlashLoanClient.fetchClient();
	}

	private async initialize(): Promise<void> {
		await this.initATAs();
		await this.initClients();
	}

	private async initATAs(): Promise<void> {
		const oix_createATAs = [];
		for (const [index, token] of Object.entries(TOKENS)) {
			const marketIndex = Number(index) as MarketIndex;

			const marketKeypair = getMarketKeypair(
				marketIndex,
				config.LIQUIDATOR_KEYPAIR,
			);

			const tokenProgram = await getTokenProgram(this.connection, token.mint);
			const ata = await getAssociatedTokenAddress(
				token.mint,
				marketKeypair.publicKey,
				false,
				tokenProgram,
			);

			const oix_createAta = await makeCreateAtaIxIfNeeded(
				this.connection,
				ata,
				marketKeypair.publicKey,
				token.mint,
				tokenProgram,
				this.feePayer.publicKey,
			);
			if (oix_createAta.length > 0) oix_createATAs.push(...oix_createAta);

			this.splWallets[Number(marketIndex) as MarketIndex] = ata;
		}
		if (oix_createATAs.length === 0) return;

		const { transaction } = await buildTransaction(
			this.connection,
			oix_createATAs,
			this.feePayer.publicKey,
			[],
		);

		transaction.sign([this.feePayer]);
		const signature = await this.connection.sendRawTransaction(
			transaction.serialize(),
		);
		const latestBlockhash = await this.connection.getLatestBlockhash();
		await this.connection.confirmTransaction(
			{ signature, ...latestBlockhash },
			"confirmed",
		);
		this.logger.info(
			`Created associated token accounts, signature: ${signature}`,
		);
	}

	private async initClients(): Promise<void> {
		this.quartzClient = await QuartzClient.fetchClient({
			connection: this.connection,
		});
	}

	async start(): Promise<void> {
		await this.initPromise;
		this.logger.info(
			`Auto-Repay Bot initialized with address ${this.feePayer.publicKey}`,
		);

		setInterval(
			() => {
				this.logger.info(`Heartbeat | Bot address: ${this.feePayer.publicKey}`);
			},
			1000 * 60 * 60 * 24,
		);

		while (true) {
			let owners: PublicKey[];
			let users: (QuartzUser | null)[];
			try {
				[owners, users] = await retryWithBackoff(async () => {
					if (!this.quartzClient)
						throw new Error("Quartz client is not initialized");
					const owners = await this.getAllOwnersPubkeys();
					const users =
						await this.quartzClient.getMultipleQuartzAccounts(owners);
					return [owners, users];
				}, 1);
			} catch (error) {
				this.logger.error(`Error fetching users: ${error}`);
				continue;
			}

			for (let i = 0; i < owners.length; i++) {
				const user = users[i];
				try {
					if (user === null || user === undefined) {
						// TODO: Fix deactivated Drift accounts
						// this.logger.warn(`Failed to fetch Quartz user for ${owners[i]?.toBase58()}`);
						continue;
					}

					if (await this.checkRequiresUpgrade(user)) {
						// this.logger.warn(`User ${user.pubkey.toBase58()} requires upgrade`);
						continue;
					}

					if (user.getHealth() === 0) {
						this.processUser(user);
					}
				} catch (error) {
					this.logger.error(`Error processing user: ${error}`);
				}
			}

			await new Promise((resolve) => setTimeout(resolve, LOOP_DELAY));
		}
	}

	private async getAllOwnersPubkeys(): Promise<PublicKey[]> {
		if (!this.quartzClient) throw new Error("Quartz client is not initialized");

		try {
			const response = await fetchAndParse<{
				users: UserDataResponse[];
			}>(`${config.INTERNAL_API_URL}/data/all-users`);
			const owners = response.users.map(
				(user) => new PublicKey(user.vaultAccount.owner),
			);
			return owners;
		} catch (error) {
			this.logger.warn(
				`API fetch failed, falling back to RPC for getAllOwnersPubkeys: ${error} - ${JSON.stringify(error)}`,
			);
			const owners = await this.quartzClient.getAllQuartzAccountOwnerPubkeys();
			return owners;
		}
	}

	private async checkRequiresUpgrade(user: QuartzUser): Promise<boolean> {
		const vaultPdaAccount = await this.connection.getAccountInfo(
			user.vaultPubkey,
		);
		if (vaultPdaAccount === null) return true;

		const OLD_VAULT_SIZE = 41;
		return vaultPdaAccount.data.length <= OLD_VAULT_SIZE;
	}

	private async processUser(user: QuartzUser): Promise<void> {
		try {
			if (!this.quartzClient)
				throw new Error("Quartz client is not initialized");
			let hasDepositAddressBalance = false;
			const depositAddressBalances = await user.getAllDepositAddressBalances();

			const depositPromises = [];
			for (const marketIndex of MarketIndex) {
				const balance: BN = depositAddressBalances[marketIndex];
				if (balance.gt(ZERO)) {
					hasDepositAddressBalance = true;
					depositPromises.push(this.fulfilDeposit(user, marketIndex));
				}
			}
			await Promise.all(depositPromises);

			if (!hasDepositAddressBalance) {
				await this.attemptAutoRepay(user);
				return;
			}

			// If some deposits have been filled, refresh to check if health is still 0
			const refreshedUser = await this.quartzClient.getQuartzAccount(
				user.pubkey,
			);
			if (!refreshedUser) throw new Error("User not found while refreshing");
			if (refreshedUser.getHealth() === 0) {
				await this.attemptAutoRepay(refreshedUser);
			}
		} catch (error) {
			this.logger.error(
				`Error processing user: ${error} - User: ${user.pubkey.toBase58()}`,
			);
		}
	}

	private async fulfilDeposit(
		user: QuartzUser,
		marketIndex: MarketIndex,
	): Promise<void> {
		const { ixs, lookupTables, signers } = await user.makeDepositIxs(
			marketIndex,
			this.feePayer.publicKey,
		);
		const { transaction } = await buildTransaction(
			this.connection,
			ixs,
			this.feePayer.publicKey,
			lookupTables,
		);
		transaction.sign([...signers]);

		const latestBlockhash = await this.connection.getLatestBlockhash();
		const signature = await retryWithBackoff(async () =>
			this.connection.sendRawTransaction(transaction.serialize()),
		);
		await this.connection.confirmTransaction(
			{ signature, ...latestBlockhash },
			"confirmed",
		);

		this.logger.info(
			`Fulfil deposit for ${user.pubkey.toBase58()} (market index ${marketIndex}), signature: ${signature}`,
		);
	}

	private async attemptAutoRepay(user: QuartzUser): Promise<void> {
		if (!this.quartzClient) throw new Error("Quartz client is not initialized");

		const openWithdrawOrders: WithdrawOrder[] = [];
		const balances = await user.getMultipleTokenBalances(
			[...MarketIndex],
			openWithdrawOrders,
		);
		const prices = await getPrices();
		const { collateralPositions, loanPositions } = await getSortedPositions(
			balances,
			prices,
		);

		if (loanPositions.length === 0 || loanPositions[0] === undefined) {
			throw new Error("No loan positions found");
		}

		if (
			loanPositions[0].value <
			decimalToBaseUnit(MIN_LOAN_VALUE_DOLLARS, MARKET_INDEX_USDC)
		) {
			return; // Ignore cases where largest loan's value is less than minimum amount
		}

		let lastError: unknown = null;
		for (let retry = 0; retry < MAX_AUTO_REPAY_ATTEMPTS; retry++) {
			try {
				let lastError: unknown = null;
				let lastCollateralBelowMinimumError: CollateralBelowMinimumError | null =
					null;
				for (let assetsTried = 0; assetsTried < 8; assetsTried++) {
					try {
						const { quote, marketIndexLoan, marketIndexCollateral } =
							await this.fetchAutoRepayParams(
								user,
								loanPositions,
								collateralPositions,
								prices,
								balances,
								assetsTried,
							);

						const signature = await this.executeAutoRepay(
							user,
							quote,
							marketIndexLoan,
							marketIndexCollateral,
						);

						await retryWithBackoff(async () => {
							const latestBlockhash =
								await this.connection.getLatestBlockhash();
							const tx = await this.connection.confirmTransaction(
								{ signature, ...latestBlockhash },
								"confirmed",
							);

							await this.checkRemainingBalance(this.feePayer.publicKey);

							if (tx.value.err)
								throw new Error(
									`Tx passed preflight but failed on-chain: ${signature}`,
								);
						}, 1);

						this.logger.info(
							`Executed auto-repay for ${user.pubkey.toBase58()}, signature: ${signature}`,
						);

						return;
					} catch (error) {
						if (error instanceof CollateralBelowMinimumError) {
							lastCollateralBelowMinimumError = error;
						} else {
							lastError = error;
						}
					}
				}

				if (lastError) {
					throw lastError;
				}
				if (lastCollateralBelowMinimumError) {
					throw lastCollateralBelowMinimumError;
				}
			} catch (error) {
				if (error instanceof CollateralBelowMinimumError) {
					const collateralValue = baseUnitToDecimal(
						error.collateralValue,
						MARKET_INDEX_USDC,
					);
					this.logger.warn(
						`Collateral of $${collateralValue} is below minimum amount for ${user.pubkey.toBase58()}, skipping auto-repay`,
					);
					return;
				}

				lastError = error;
				this.logger.warn(
					`Auto-repay transaction failed for ${user.pubkey.toBase58()}, retrying... Error: ${lastError}`,
				);

				const delay = 2_000 * (retry + 1);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		try {
			const refreshedUser = await this.quartzClient.getQuartzAccount(
				user.pubkey,
			);
			const refreshedHealth = refreshedUser?.getHealth();
			if (refreshedHealth === undefined || refreshedHealth === 0)
				throw lastError;
		} catch (error) {
			let slippageError = "";
			if (
				error instanceof SendTransactionError &&
				(await isSlippageError(error, this.connection))
			) {
				slippageError = " [Slippage Exceeded]";
			}

			this.logger.error(
				`Failed to execute auto-repay for ${user.pubkey.toBase58()}.${slippageError} Error: ${error}`,
			);
		}
	}

	private async fetchAutoRepayParams(
		user: QuartzUser,
		loanPositions: Position[],
		collateralPositions: Position[],
		prices: Record<MarketIndex, number>,
		balances: Record<MarketIndex, BN>,
		skipAssetsUpTo = 0,
	): Promise<{
		quote: QuoteResponse;
		marketIndexLoan: MarketIndex;
		marketIndexCollateral: MarketIndex;
	}> {
		if (!this.quartzClient) throw new Error("Quartz client is not initialized");
		let isCollateralAboveMin = false;

		// Try each token pair for a Jupiter quote, from largest to smallest values
		for (const loanPosition of loanPositions) {
			for (const collateralPosition of collateralPositions.slice(
				skipAssetsUpTo,
			)) {
				if (loanPosition.marketIndex === collateralPosition.marketIndex) {
					continue;
				}

				const marketIndexLoan = loanPosition.marketIndex;
				const marketIndexCollateral = collateralPosition.marketIndex;

				const collateralWeight =
					(await this.quartzClient.getCollateralWeight(marketIndexCollateral)) /
					100;
				const liabilityWeight =
					200 -
					(await this.quartzClient.getCollateralWeight(marketIndexLoan)) / 100; // Liability weight is the inverse of collateralWeight (eg: 80% => 120%)
				const loanRepayUsdcValue = await user.getRepayUsdcValueForTargetHealth(
					GOAL_HEALTH,
					collateralWeight,
					liabilityWeight,
				);

				// Ignore cases where largest loan's value is less than minimum amount
				if (
					loanRepayUsdcValue <
					decimalToBaseUnit(MIN_LOAN_VALUE_DOLLARS, MARKET_INDEX_USDC)
				) {
					continue;
				}

				// If any case is above minimum, set flag to true
				isCollateralAboveMin = true;

				try {
					return await fetchExactOutParams(
						marketIndexCollateral,
						marketIndexLoan,
						loanRepayUsdcValue,
						prices[marketIndexLoan],
						prices[marketIndexCollateral],
						balances[marketIndexCollateral].toNumber(),
					);
				} catch {
					try {
						return await fetchExactInParams(
							marketIndexCollateral,
							marketIndexLoan,
							loanRepayUsdcValue,
							prices[marketIndexCollateral],
							balances[marketIndexCollateral].toNumber(),
						);
					} catch {} // Ignore error until no routes are found
				}
			}
		}

		if (!isCollateralAboveMin) {
			const totalCollateralValue = await user.getTotalCollateralValue([]);
			throw new CollateralBelowMinimumError(totalCollateralValue);
		}

		throw new Error("No valid Jupiter quote found");
	}

	private async executeAutoRepay(
		user: QuartzUser,
		quote: QuoteResponse,
		marketIndexLoan: MarketIndex,
		marketIndexCollateral: MarketIndex,
	): Promise<string> {
		if (
			!this.splWallets[marketIndexLoan] ||
			!this.splWallets[marketIndexCollateral] ||
			!this.quartzClient
		) {
			throw new Error("AutoRepayBot is not initialized");
		}

		const marketKeypair = getMarketKeypair(
			marketIndexLoan,
			config.LIQUIDATOR_KEYPAIR,
		);

		// Fetch quote and balances
		const startingCollateralBalancePromise = getTokenAccountBalance(
			this.connection,
			this.splWallets[marketIndexCollateral],
		);
		const startingLamportsBalancePromise = retryWithBackoff(async () => {
			return await this.connection.getBalance(marketKeypair.publicKey);
		});

		const [startingLamportsBalance, startingCollateralBalance] =
			await Promise.all([
				startingLamportsBalancePromise,
				startingCollateralBalancePromise,
			]);

		// Calculate balance amounts
		const { ix: swapIx, lookupTables: jupiterLookupTables } =
			await makeJupiterIx(this.connection, quote, marketKeypair.publicKey);

		const requiredCollateralForRepay = Number(quote.inAmount);
		if (Number.isNaN(requiredCollateralForRepay)) {
			throw new Error("Invalid quote");
		}
		if (!Number.isInteger(requiredCollateralForRepay)) {
			throw new Error("Swap quote returned decimal for inAmount");
		}

		const amountExtraCollateralRequired = Math.max(
			0,
			requiredCollateralForRepay - startingCollateralBalance,
		);

		// Wrap any SOL if needed
		let lamportsToWrap = 0;
		let oix_createWSolAta: TransactionInstruction[] = [];
		const oix_wrapSol: TransactionInstruction[] = [];
		if (marketIndexLoan === MARKET_INDEX_SOL) {
			oix_createWSolAta = await makeCreateAtaIxIfNeeded(
				this.connection,
				this.splWallets[marketIndexLoan],
				marketKeypair.publicKey,
				TOKENS[marketIndexLoan].mint,
				TOKEN_PROGRAM_ID,
				marketKeypair.publicKey,
			);
		} else if (marketIndexCollateral === MARKET_INDEX_SOL) {
			const wrappableLamports = Math.max(
				0,
				startingLamportsBalance - MIN_LAMPORTS_BALANCE,
			);
			lamportsToWrap = Math.min(
				amountExtraCollateralRequired,
				wrappableLamports,
			);

			oix_createWSolAta = await makeCreateAtaIxIfNeeded(
				this.connection,
				this.splWallets[marketIndexCollateral],
				marketKeypair.publicKey,
				TOKENS[marketIndexCollateral].mint,
				TOKEN_PROGRAM_ID,
				marketKeypair.publicKey,
			);
		}

		if (lamportsToWrap > 0) {
			oix_wrapSol.push(
				SystemProgram.transfer({
					fromPubkey: marketKeypair.publicKey,
					toPubkey: this.splWallets[MARKET_INDEX_SOL],
					lamports: lamportsToWrap,
				}),
				createSyncNativeInstruction(this.splWallets[MARKET_INDEX_SOL]),
			);
		}

		// Build instructions
		const amountCollateralToBorrow = Math.max(
			0,
			amountExtraCollateralRequired - lamportsToWrap,
		);
		const isOwnerSigner = false;
		const { ixs: ixs_autoRepay, lookupTables: pyraLookupTables } =
			await user.makeSwapIxs(
				marketKeypair.publicKey,
				this.feePayer.publicKey,
				marketIndexCollateral,
				marketIndexLoan,
				[swapIx],
				isOwnerSigner,
			);

		const instructions = [
			...oix_createWSolAta,
			...oix_wrapSol,
			...ixs_autoRepay,
		];

		let transaction: VersionedTransaction;

		if (amountCollateralToBorrow > 0) {
			transaction = await this.flashLoanClient.buildFlashLoanTx(
				marketIndexCollateral,
				amountCollateralToBorrow,
				instructions,
				[...jupiterLookupTables, ...pyraLookupTables],
			);
		} else {
			const { transaction: tx } = await buildTransaction(
				this.connection,
				instructions,
				this.feePayer.publicKey,
				[...jupiterLookupTables, ...pyraLookupTables],
			);
			transaction = tx;
		}

		transaction.sign([this.feePayer, marketKeypair]);

		const signature = await retryWithBackoff(async () =>
			this.connection.sendRawTransaction(transaction.serialize()),
		);

		return signature;
	}

	private async checkRemainingBalance(address: PublicKey): Promise<void> {
		const remainingLamports = await this.connection.getBalance(address);
		if (remainingLamports < MIN_LAMPORTS_BALANCE) {
			this.sendEmail(
				"AUTO_REPAY_BOT balance is low",
				`Auto-repay bot balance is ${remainingLamports}, please add more SOL to ${address.toBase58()}`,
			);
		}
	}
}
