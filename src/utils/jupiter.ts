import type { QuoteResponse, SwapMode } from "@jup-ag/api";
import { buildEndpointURL, fetchAndParse } from "@quartz-labs/sdk";
import {
	AddressLookupTableAccount,
	PublicKey,
	TransactionInstruction,
	type Connection,
} from "@solana/web3.js";

export async function getJupiterSwapQuote(
	swapMode: SwapMode,
	inputMint: PublicKey,
	outputMint: PublicKey,
	amount: number,
	slippageBps: number,
) {
	const endpoint = buildEndpointURL("https://lite-api.jup.ag/swap/v1/quote", {
		inputMint: inputMint.toBase58(),
		outputMint: outputMint.toBase58(),
		amount: amount.toString(),
		slippageBps: slippageBps.toString(),
		swapMode,
		onlyDirectRoutes: "true",
	});
	return await fetchAndParse<QuoteResponse>(endpoint);
}

export async function makeJupiterIx(
	connection: Connection,
	jupiterQuote: QuoteResponse,
	address: PublicKey,
): Promise<{
	ix: TransactionInstruction;
	lookupTables: AddressLookupTableAccount[];
}> {
	const instructions = (await (
		await fetch("https://lite-api.jup.ag/swap/v1/swap-instructions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				quoteResponse: jupiterQuote,
				userPublicKey: address.toBase58(),
			}),
		})
	)
		// biome-ignore lint/suspicious/noExplicitAny: <not worth adding types if replacing with Titan>
		.json()) as any;

	if (instructions.error) {
		throw new Error(`Failed to get swap instructions: ${instructions.error}`);
	}

	const { swapInstruction, addressLookupTableAddresses } = instructions;

	// biome-ignore lint/suspicious/noExplicitAny: <not worth adding types if replacing with Titan>
	const deserializeInstruction = (instruction: any) => {
		return new TransactionInstruction({
			programId: new PublicKey(instruction.programId),
			keys: instruction.accounts.map(
				(key: { pubkey: string; isSigner: boolean; isWritable: boolean }) => ({
					pubkey: new PublicKey(key.pubkey),
					isSigner: key.isSigner,
					isWritable: key.isWritable,
				}),
			),
			data: Buffer.from(instruction.data, "base64"),
		});
	};

	const getAddressLookupTableAccounts = async (
		keys: string[],
	): Promise<AddressLookupTableAccount[]> => {
		const addressLookupTableAccountInfos =
			await connection.getMultipleAccountsInfo(
				keys.map((key) => new PublicKey(key)),
			);

		return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
			const addressLookupTableAddress = keys[index];
			if (accountInfo && addressLookupTableAddress) {
				const addressLookupTableAccount = new AddressLookupTableAccount({
					key: new PublicKey(addressLookupTableAddress),
					state: AddressLookupTableAccount.deserialize(accountInfo.data),
				});
				acc.push(addressLookupTableAccount);
			}

			return acc;
		}, new Array<AddressLookupTableAccount>());
	};

	const addressLookupTableAccounts = await getAddressLookupTableAccounts(
		addressLookupTableAddresses,
	);

	return {
		ix: deserializeInstruction(swapInstruction),
		lookupTables: addressLookupTableAccounts,
	};
}
