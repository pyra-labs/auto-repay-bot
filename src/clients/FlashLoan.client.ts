import {
	getConfig,
	MarginfiClient,
	type MarginfiAccountWrapper,
} from "@mrgnlabs/marginfi-client-v2";
import { AppLogger } from "@quartz-labs/logger";
import {
	baseUnitToDecimal,
	DummyWallet,
	getComputeUnitPriceIx,
	getMarketIndicesRecord,
	getMarketKeypair,
	getTokenProgram,
	makeCreateAtaIxIfNeeded,
	MarketIndex,
	TOKENS,
} from "@quartz-labs/sdk";
import config from "../config/config.js";
import AdvancedConnection from "@quartz-labs/connection";
import {
	TransactionMessage,
	VersionedTransaction,
	type AddressLookupTableAccount,
	type Keypair,
	type TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export class FlashLoanClient extends AppLogger {
	private static instance: FlashLoanClient;

	private connection: AdvancedConnection;
	private clientsPromise: Promise<Record<MarketIndex, MarginfiClient>>;
	private accountsPromise: Promise<Record<MarketIndex, MarginfiAccountWrapper>>;

	public static fetchClient(): FlashLoanClient {
		if (!FlashLoanClient.instance) {
			FlashLoanClient.instance = new FlashLoanClient();
		}
		return FlashLoanClient.instance;
	}

	private constructor() {
		super({
			name: "Card Workers | MarginFi Client",
			dailyErrorCacheTimeMs: 1000 * 60 * 5, // 5 minute cache
		});

		this.connection = new AdvancedConnection(config.RPC_URLS);
		this.clientsPromise = this.fetchClients();
		this.accountsPromise = this.fetchAccounts();
	}

	private async fetchClients(): Promise<Record<MarketIndex, MarginfiClient>> {
		const clients: Record<MarketIndex, MarginfiClient | null> =
			getMarketIndicesRecord(null);

		for (const marketIndex of MarketIndex) {
			const liquidator = this.getCaller(marketIndex);
			const wallet = new DummyWallet(liquidator.publicKey);
			clients[marketIndex] = await MarginfiClient.fetch(
				getConfig(),
				wallet,
				this.connection,
			);
		}

		const nullEntry = Object.entries(clients).find(
			([_index, client]) => client === null,
		);
		if (nullEntry) {
			throw new Error(
				`Failed to fetch Marginfi client for market index ${nullEntry[0]}`,
			);
		}

		this.logger.info(`Fetched ${Object.keys(clients).length} Marginfi clients`);

		return clients as Record<MarketIndex, MarginfiClient>;
	}

	private async fetchAccounts(): Promise<
		Record<MarketIndex, MarginfiAccountWrapper>
	> {
		const clients = await this.clientsPromise;

		const accounts: Record<MarketIndex, MarginfiAccountWrapper | null> =
			getMarketIndicesRecord(null);

		for (const marketIndex of MarketIndex) {
			const client = clients[marketIndex];
			const liquidator = this.getCaller(marketIndex);

			const [account] = await client.getMarginfiAccountsForAuthority(
				liquidator.publicKey,
			);
			if (account?.isDisabled) {
				throw new Error(
					`Marginfi account for market index ${marketIndex} is disabled`,
				);
			}

			accounts[marketIndex] = account || null;
		}

		const nullEntry = Object.entries(accounts).find(
			([_index, client]) => client === null,
		);
		if (nullEntry) {
			throw new Error(
				`Failed to fetch Marginfi account for market index ${nullEntry[0]}`,
			);
		}

		this.logger.info(
			`Fetched ${Object.keys(accounts).length} Marginfi accounts`,
		);

		return accounts as Record<MarketIndex, MarginfiAccountWrapper>;
	}

	public getCaller(marketIndex: MarketIndex): Keypair {
		return getMarketKeypair(marketIndex, config.LIQUIDATOR_KEYPAIR);
	}

	public async buildFlashLoanTx(
		marketIndex: MarketIndex,
		amountBaseUnits: number,
		instructions: TransactionInstruction[],
		lookupTables: AddressLookupTableAccount[],
	): Promise<VersionedTransaction> {
		const liquidator = this.getCaller(marketIndex);
		const marginfiClient = (await this.clientsPromise)[marketIndex];
		const marginfiAccount = (await this.accountsPromise)[marketIndex];

		const mint = TOKENS[marketIndex].mint;
		const loanBank = marginfiClient.getBankByMint(mint);
		if (!loanBank) {
			throw new Error(`Loan bank for market index ${marketIndex} not found`);
		}

		// Set compute unit price
		const ix_computePrice = await getComputeUnitPriceIx(
			this.connection,
			instructions,
		);

		// Make ATA instructions
		const tokenProgram = await getTokenProgram(this.connection, mint);
		const walletAtaLoan = getAssociatedTokenAddressSync(
			mint,
			liquidator.publicKey,
			true,
			tokenProgram,
		);
		const oix_createAtaLoan = await makeCreateAtaIxIfNeeded(
			this.connection,
			walletAtaLoan,
			liquidator.publicKey,
			mint,
			tokenProgram,
			liquidator.publicKey,
		);

		// Make borrow & deposit instructions
		const amountDecimal = baseUnitToDecimal(amountBaseUnits, marketIndex);
		const { instructions: ix_borrow } = await marginfiAccount.makeBorrowIx(
			amountDecimal,
			loanBank.address,
			{
				createAtas: false,
				wrapAndUnwrapSol: false,
				overrideInferAccounts: {
					authority: liquidator.publicKey,
				},
			},
		);

		const { instructions: ix_repay } = await marginfiAccount.makeRepayIx(
			amountDecimal,
			loanBank.address,
			false,
			{
				wrapAndUnwrapSol: false,
				overrideInferAccounts: {
					authority: liquidator.publicKey,
				},
			},
		);

		const innerInstructions = [
			ix_computePrice,
			...oix_createAtaLoan,
			...ix_borrow,
			...instructions,
			...ix_repay,
		];
		const beginFlashLoanIx = await marginfiAccount.makeBeginFlashLoanIx(
			innerInstructions.length + 1,
		);

		const activeBanks = await marginfiAccount.activeBalances.map(
			(b) => b.bankPk,
		);
		if (!activeBanks.some((bank) => bank.equals(loanBank.address))) {
			activeBanks.unshift(loanBank.address); // Add loan bank to the beginning of the array if it's not already present
		}
		const endFlashLoanIx =
			await marginfiAccount.makeEndFlashLoanIx(activeBanks);

		const finalInstructions = [
			...beginFlashLoanIx.instructions,
			...innerInstructions,
			...endFlashLoanIx.instructions,
		];

		const blockhash = (await this.connection.getLatestBlockhash()).blockhash;
		const messageV0 = new TransactionMessage({
			payerKey: liquidator.publicKey,
			recentBlockhash: blockhash,
			instructions: finalInstructions,
		}).compileToV0Message(lookupTables);
		const transaction = new VersionedTransaction(messageV0);

		transaction.sign([liquidator]);
		return transaction;
	}
}
