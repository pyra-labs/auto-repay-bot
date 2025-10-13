import {
	Keypair,
	PublicKey,
	SendTransactionError,
	SystemProgram,
	type TransactionInstruction,
	type VersionedTransaction,
} from "@solana/web3.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import {
	getConfig as getMarginfiConfig,
	MarginfiClient,
} from "@mrgnlabs/marginfi-client-v2";
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
} from "./utils/helpers.js";
import config from "./config/config.js";
import {
	MarketIndex,
	getTokenProgram,
	QuartzClient,
	type QuartzUser,
	TOKENS,
	makeCreateAtaIxIfNeeded,
	baseUnitToDecimal,
	type BN,
	retryWithBackoff,
	MARKET_INDEX_SOL,
	decimalToBaseUnit,
	MARKET_INDEX_USDC,
	getComputeUnitPriceIx,
	ZERO,
	buildTransaction,
	fetchAndParse,
	type WithdrawOrder,
} from "@quartz-labs/sdk";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import type { Position } from "./types/Position.interface.js";
import { AppLogger } from "@quartz-labs/logger";
import AdvancedConnection from "@quartz-labs/connection";
import { CollateralBelowMinimumError } from "./types/errors.js";
import { getOrcaSwapIx } from "./utils/orca.js";
import type { UserDataResponse } from "./types/Vault.interface.js";

export class AutoRepayBot extends AppLogger {
	private initPromise: Promise<void>;

	private connection: AdvancedConnection;
	private feePayer: Keypair;
	private splWallets = {} as Record<MarketIndex, PublicKey>;

	private quartzClient: QuartzClient | undefined;
	private marginfiClient: MarginfiClient | undefined;

	constructor() {
		super({
			name: "Auto-Repay Bot",
			dailyErrorCacheTimeMs: 1000 * 60 * 15, // 15 minutes
		});

		this.connection = new AdvancedConnection(config.RPC_URLS);
		this.feePayer = Keypair.fromSecretKey(config.LIQUIDATOR_KEYPAIR);

		this.initPromise = this.initialize();
	}

	private async initialize(): Promise<void> {
		await this.initATAs();
		await this.initClients();
	}

	private async initATAs(): Promise<void> {
		const quartzClient = await QuartzClient.fetchClient({
			connection: this.connection,
		});

		const oix_createATAs = [];
		for (const [index, token] of Object.entries(TOKENS)) {
			const marketIndex = Number(index) as MarketIndex;

			const marketKeypair = quartzClient.getMarketKeypair(
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

		this.marginfiClient = await MarginfiClient.fetch(
			getMarginfiConfig(),
			new NodeWallet(this.feePayer),
			this.connection,
		);
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
		const { ixs, lookupTables, signers } = await user.makeFulfilDepositIxs(
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
				for (let assetsTried = 0; assetsTried < 8; assetsTried++) {
					try {
						const {
							swapAmountBaseUnits,
							marketIndexLoan,
							marketIndexCollateral,
						} = await this.fetchAutoRepayParams(
							user,
							loanPositions,
							collateralPositions,
							prices,
							balances,
							assetsTried,
						);

						const signature = await this.executeAutoRepay(
							user,
							swapAmountBaseUnits,
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
						lastError = error;
					}
				}

				if (lastError) throw lastError;
			} catch (error) {
				if (error instanceof CollateralBelowMinimumError) {
					this.logger.warn(
						`Collateral is below minimum amount for ${user.pubkey.toBase58()}, skipping auto-repay`,
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
		swapAmountBaseUnits: number;
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

				// TODO: Add back in ExactOut once Jupiter/Orca situation is sorted
				// try {
				//     return await fetchExactOutParams(
				//         marketIndexCollateral,
				//         marketIndexLoan,
				//         loanRepayUsdcValue,
				//         prices[marketIndexLoan],
				//         prices[marketIndexCollateral],
				//         balances[marketIndexCollateral].toNumber()
				//     );
				// } catch {
				try {
					return await fetchExactInParams(
						marketIndexCollateral,
						marketIndexLoan,
						loanRepayUsdcValue,
						prices[marketIndexCollateral],
						balances[marketIndexCollateral].toNumber(),
					);
				} catch {} // Ignore error until no routes are found
				// }
			}
		}

		if (!isCollateralAboveMin) {
			throw new CollateralBelowMinimumError();
		}

		throw new Error("No valid Jupiter quote found");
	}

	private async executeAutoRepay(
		user: QuartzUser,
		swapAmount: number,
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

		const marketKeypair = this.quartzClient.getMarketKeypair(
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
		const { ix: swapIx, inAmountRequiredForSwap: requiredCollateralForRepay } =
			await getOrcaSwapIx(
				this.connection,
				marketKeypair.publicKey,
				TOKENS[marketIndexCollateral].mint,
				TOKENS[marketIndexLoan].mint,
				swapAmount,
			);

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
		const collateralToBorrow = Math.max(
			0,
			amountExtraCollateralRequired - lamportsToWrap,
		);
		const { ixs: ixs_autoRepay, lookupTables } =
			await user.makeCollateralRepayIxs(
				marketKeypair.publicKey,
				marketIndexLoan,
				marketIndexCollateral,
				swapIx,
			);

		const instructions = [
			...oix_createWSolAta,
			...oix_wrapSol,
			...ixs_autoRepay,
		];
		const transaction = await this.buildAutoRepayTx(
			collateralToBorrow,
			marketIndexCollateral,
			instructions,
			lookupTables,
			marketKeypair,
		);
		transaction.sign([this.feePayer]);

		const signature = await retryWithBackoff(async () =>
			this.connection.sendRawTransaction(transaction.serialize()),
		);

		return signature;
	}

	private async buildAutoRepayTx(
		collateralToBorrow: number,
		marketIndexCollateral: MarketIndex,
		instructions: TransactionInstruction[],
		lookupTables: AddressLookupTableAccount[],
		marketKeypair: Keypair,
	): Promise<VersionedTransaction> {
		if (!this.marginfiClient) {
			throw new Error("AutoRepayBot is not initialized");
		}

		if (collateralToBorrow > 0) {
			const amountCollateralDecimal = baseUnitToDecimal(
				collateralToBorrow,
				marketIndexCollateral,
			);
			const collateralBank = await this.marginfiClient.getBankByMint(
				TOKENS[marketIndexCollateral].mint,
			);
			if (!collateralBank)
				throw new Error("Collateral bank for flash loan not found");

			const marginfiAccount = await this.marginfiClient
				.getMarginfiAccountsForAuthority(marketKeypair.publicKey)
				.then((accounts) => accounts[0]);
			if (!marginfiAccount) {
				throw new Error(
					`Marginfi account not found for market index ${marketIndexCollateral} and authority ${marketKeypair.publicKey.toBase58()}`,
				);
			}

			const ix_computePrice = await getComputeUnitPriceIx(
				this.connection,
				instructions,
			);
			const { instructions: ix_borrow } = await marginfiAccount.makeBorrowIx(
				amountCollateralDecimal,
				collateralBank.address,
				{
					createAtas: false,
					wrapAndUnwrapSol: false,
				},
			);
			const { instructions: ix_repay } = await marginfiAccount.makeRepayIx(
				amountCollateralDecimal,
				collateralBank.address,
				false,
				{
					wrapAndUnwrapSol: false,
				},
			);

			const flashloanTx = await marginfiAccount.buildFlashLoanTx({
				ixs: [ix_computePrice, ...ix_borrow, ...instructions, ...ix_repay],
				addressLookupTableAccounts: lookupTables,
			});

			return flashloanTx;
		}

		// If no loan required, build regular tx
		const { transaction } = await buildTransaction(
			this.connection,
			instructions,
			this.feePayer.publicKey,
			lookupTables,
		);
		return transaction;
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
