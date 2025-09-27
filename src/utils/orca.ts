import { AnchorProvider } from "@coral-xyz/anchor";
import {
	buildWhirlpoolClient,
	IGNORE_CACHE,
	ORCA_WHIRLPOOL_PROGRAM_ID,
	swapQuoteByInputToken,
	UseFallbackTickArray,
	WhirlpoolContext,
} from "@orca-so/whirlpools-sdk";
import {
	buildEndpointURL,
	DummyWallet,
	fetchAndParse,
	TOKENS,
	BN,
} from "@quartz-labs/sdk";
import {
	PublicKey,
	type Connection,
	type TransactionInstruction,
} from "@solana/web3.js";
import { SWAP_SLIPPAGE_BPS } from "../config/constants.js";
import { Percentage } from "@orca-so/common-sdk";

export async function getOrcaSwapIx(
	connection: Connection,
	caller: PublicKey,
	fromMint: PublicKey,
	toMint: PublicKey,
	amount: number,
): Promise<{
	ix: TransactionInstruction;
	inAmountRequiredForSwap: number;
}> {
	const provider = new AnchorProvider(connection, new DummyWallet(caller), {
		commitment: "confirmed",
	});
	const orcaContext = WhirlpoolContext.withProvider(
		provider,
		ORCA_WHIRLPOOL_PROGRAM_ID,
		undefined,
		undefined,
		{
			accountResolverOptions: {
				createWrappedSolAccountMethod: "ata",
				allowPDAOwnerAddress: true,
			},
		},
	);
	const whirlpoolClient = buildWhirlpoolClient(orcaContext);

	const slippage = Percentage.fromFraction(SWAP_SLIPPAGE_BPS, 1000);

	const fromToken = Object.values(TOKENS).find(
		(token) => token.mint === fromMint,
	);
	const toToken = Object.values(TOKENS).find((token) => token.mint === toMint);

	const url = buildEndpointURL("https://api.orca.so/v2/solana/pools/search", {
		q: `${fromToken?.name.toUpperCase()} ${toToken?.name.toUpperCase()}`,
		sortBy: "volume8h",
		sortDirection: "desc",
	});
	const response = await fetchAndParse<{
		data: {
			address: string;
		}[];
	}>(url, {
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
	});
	const whirlpoolPubkey = response.data[0]?.address;
	if (!whirlpoolPubkey) {
		throw new Error("No whirlpool found");
	}

	const whirlpool = await whirlpoolClient.getPool(
		new PublicKey(whirlpoolPubkey),
	);

	console.log({
		whirlpoolPubkey,
		fromMint: fromMint.toBase58(),
		toMint: toMint.toBase58(),
		amount,
		slippage: {
			numerator: slippage.numerator.toNumber(),
			denominator: slippage.denominator.toNumber(),
		},
		orcaProgram: orcaContext.program.programId,
	});
	const quote = await swapQuoteByInputToken(
		// Error thrown here
		whirlpool,
		fromMint,
		new BN(amount),
		slippage,
		orcaContext.program.programId,
		orcaContext.fetcher,
		IGNORE_CACHE,
		UseFallbackTickArray.Always, // Same error if this line is removed
	);
	console.log("This point is not reached");

	const inAmountRequiredForSwap = Math.ceil(
		quote.estimatedAmountIn.toNumber() * (1 + SWAP_SLIPPAGE_BPS / 10_000),
	);

	const txBuilder = await whirlpool.swap(quote);

	const { instructions } = txBuilder.compressIx(true);

	const swapIx = instructions.find((ix) =>
		ix.programId.equals(ORCA_WHIRLPOOL_PROGRAM_ID),
	);
	if (!swapIx) {
		throw new Error("No swap instruction found");
	}

	return {
		ix: swapIx,
		inAmountRequiredForSwap,
	};
}
