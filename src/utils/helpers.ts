import { type Connection, ComputeBudgetProgram, type PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import type { Logger } from "winston";
import { SwapMode, type QuoteResponse } from "@jup-ag/api";
import { baseUnitToDecimal, decimalToBaseUnit, MarketIndex, TOKENS, type BN, type QuartzUser } from "@quartz-labs/sdk";
import type { PythResponse } from "../types/Pyth.interface.js";
import type { Position } from "../types/Position.interface.js";
import { DEFAULT_COMPUTE_UNIT_LIMIT, JUPITER_SLIPPAGE_BPS } from "../config/constants.js";
import type { AddressLookupTableAccount, TransactionInstruction } from "@solana/web3.js";

export async function getJupiterSwapQuote(
    swapMode: SwapMode,
    inputMint: PublicKey, 
    outputMint: PublicKey, 
    amount: number,
    slippageBps: number
) {
    const quoteEndpoint = 
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=${slippageBps}&swapMode=${swapMode}&onlyDirectRoutes=true`;
    const response = await fetch(quoteEndpoint);
    if (!response.ok) throw new Error("Could not fetch Jupiter quote");
    
    const body = await response.json() as QuoteResponse;
    return body;
}

export async function fetchExactOutParams(
    marketIndexCollateral: MarketIndex,
    marketIndexLoan: MarketIndex,
    loanRepayValue: number,
    loanPrice: number,
    collateralPrice: number,
    collateralBalance: number,
) {
    // Ensure the collateral required for the loan repay is not higher than the collateral balance
    const targetRepayAmountLoan = loanRepayValue / loanPrice;
    const collateralBalanceValue = baseUnitToDecimal(collateralBalance, marketIndexCollateral) * collateralPrice;
    const loanEquivalent = collateralBalanceValue / loanPrice;
    const repayAmountLoan = Math.min(targetRepayAmountLoan, loanEquivalent);

    console.log(loanRepayValue, targetRepayAmountLoan, collateralBalanceValue, loanEquivalent, repayAmountLoan);

    await getJupiterSwapQuote(
        SwapMode.ExactOut,
        TOKENS[marketIndexLoan].mint, 
        TOKENS[marketIndexCollateral].mint, 
        repayAmountLoan, 
        JUPITER_SLIPPAGE_BPS
    );

    return {
        swapMode: SwapMode.ExactOut,
        swapAmountBaseUnits: Math.floor(repayAmountLoan),
        marketIndexLoan,
        marketIndexCollateral
    }
}

export async function fetchExactInParams(
    marketIndexCollateral: MarketIndex,
    marketIndexLoan: MarketIndex,
    loanRepayValue: number,
    collateralPrice: number,
    collateralBalance: number
) {
    const targetRepayAmountCollateralDecimal = loanRepayValue / collateralPrice;
    const repayAmountCollateral = Math.max(
        decimalToBaseUnit(targetRepayAmountCollateralDecimal, marketIndexCollateral), 
        collateralBalance
    );

    await getJupiterSwapQuote(
        SwapMode.ExactIn,
        TOKENS[marketIndexCollateral].mint, 
        TOKENS[marketIndexLoan].mint, 
        repayAmountCollateral, 
        JUPITER_SLIPPAGE_BPS
    );

    return {
        swapMode: SwapMode.ExactIn,
        swapAmountBaseUnits: Math.floor(repayAmountCollateral),
        marketIndexLoan,
        marketIndexCollateral
    }
}

export const retryRPCWithBackoff = async <T>(
    fn: () => Promise<T>,
    retries: number,
    initialDelay: number,
    logger?: Logger
): Promise<T> => {
    let lastError = new Error("Unknown error");
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('503')) {
                    const delay = initialDelay * (2 ** i);
                    if (logger) logger.warn(`RPC node unavailable, retrying in ${delay}ms...`);
                    
                    await new Promise(resolve => setTimeout(resolve, delay));
                    lastError = error;
                    continue;
                }
                throw error;
            }
            lastError = new Error(String(error));
        }
    }
    throw lastError;
}

export async function getTokenAccountBalance(connection: Connection, tokenAccount: PublicKey) {
    const account = await connection.getAccountInfo(tokenAccount);
    if (account === null) return 0;
    
    return await retryRPCWithBackoff(
        async () => {
            const balance = await connection.getTokenAccountBalance(tokenAccount);
            return Number(balance.value.amount);
        },
        3,
        1_000
    );
}

export async function getPrices(): Promise<Record<MarketIndex, number>> {
    try {
        return await getPricesPyth();
    } catch {
        try {
            return await getPricesCoinGecko();
        } catch {
            throw new Error("Failed to fetch prices from main (Pyth) and backup (CoinGecko) sources");
        }
    }
}

async function getPricesPyth(): Promise<Record<MarketIndex, number>> {
    const pythPriceFeedIdParams = MarketIndex.map(index => `ids%5B%5D=${TOKENS[index].pythPriceFeedId}`);
    const endpoint = `https://hermes.pyth.network/v2/updates/price/latest?${pythPriceFeedIdParams.join("&")}`;
    const reponse = await fetch(endpoint);
    if (!reponse.ok) throw new Error("Failed to fetch prices");
    const body = await reponse.json() as PythResponse;
    const pricesData = body.parsed;

    const prices = {} as Record<MarketIndex, number>;
    for (const index of MarketIndex) {
        prices[index] = 0;
    }
    
    for (const priceData of pricesData) {
        const marketIndex = MarketIndex.find(index => TOKENS[index].pythPriceFeedId.slice(2) === priceData.id);
        if (marketIndex === undefined) continue;

        const price = Number(priceData.price.price) * (10 ** priceData.price.expo);
        prices[marketIndex] = price;
    }

    return prices;
}

async function getPricesCoinGecko(): Promise<Record<MarketIndex, number>> {
    const coinGeckoIdParams = MarketIndex.map(index => TOKENS[index].coingeckoPriceId).join(",");
    const endpoint = `https://api.coingecko.com/api/v3/simple/price?ids=${coinGeckoIdParams}&vs_currencies=usd`;
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error("Failed to fetch prices");
    const body = await response.json() as Record<string, { usd: number }>;
    
    const prices = {} as Record<MarketIndex, number>;
    for (const index of MarketIndex) {
        prices[index] = 0;
    }

    for (const id of Object.keys(body)) {
        const marketIndex = MarketIndex.find(index => TOKENS[index].coingeckoPriceId === id);
        if (marketIndex === undefined) continue;

        const value = body[id];
        if (value === undefined) continue;

        prices[marketIndex] = value.usd;
    }

    return prices;
}

export async function getSortedPositions(
    balances: Record<MarketIndex, BN>,
    prices: Record<MarketIndex, number>
): Promise<{
    collateralPositions: Position[],
    loanPositions: Position[]
}> { 
    const values = Object.fromEntries(
        Object.entries(balances).map(([index, balance]) => [
            index,
            prices[Number(index) as MarketIndex] * balance.toNumber()
        ])
    ) as Record<MarketIndex, number>;

    const collateralPositions = Object.entries(values)
        .filter(([, value]) => value > 0)
        .sort(([, a], [, b]) => b - a) // Sort high to low
        .map(([index, value]) => ({
            marketIndex: Number(index) as MarketIndex,
            value
        }));

    const loanPositions = Object.entries(values)
        .filter(([, value]) => value < 0)
        .sort(([, a], [, b]) => a - b) // Sort low to high (meaning high to low in absolute value)
        .map(([index, value]) => ({
            marketIndex: Number(index) as MarketIndex,
            value: Math.abs(value)
        }));

    return { 
        collateralPositions, 
        loanPositions
    };
}

export async function getRepayMarketIndices(user: QuartzUser) {
    const balancesArray = await Promise.all(
        MarketIndex.map(async index => ({
            index,
            balance: await user.getTokenBalance(index)
        }))
    );

    const balances = balancesArray.reduce((acc, { index, balance }) => 
        Object.assign(acc, { [index]: balance }
    ), {} as Record<MarketIndex, BN>);

    let lowestBalance: {index: MarketIndex, balance: BN} 
        = { index: MarketIndex[0], balance: balances[MarketIndex[0]] };
    let highestBalance: {index: MarketIndex, balance: BN} 
        = { index: MarketIndex[0], balance: balances[MarketIndex[0]] };

    for (const marketIndex of MarketIndex) {
        const balance = balances[marketIndex];
        if (balance.lt(lowestBalance.balance)) {
            lowestBalance = { index: marketIndex, balance };
        }
        if (balance.gt(highestBalance.balance)) {
            highestBalance = { index: marketIndex, balance };
        }
    }

    return {
        marketIndexLoan: lowestBalance.index,
        marketIndexCollateral: highestBalance.index
    };
}

export async function getComputeUnitPrice() {
    // TODO: Calculate actual fee
    return 1_250_000;
};

export async function getComputeUnitPriceIx() {
    const computeUnitPrice = await getComputeUnitPrice();
    return ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: computeUnitPrice,
    });
}

export async function getComputeUnitLimit(
    connection: Connection,
    instructions: TransactionInstruction[],
    address: PublicKey,
    blockhash: string,
    lookupTables: AddressLookupTableAccount[] = []
) {
    const messageV0 = new TransactionMessage({
        payerKey: address,
        recentBlockhash: blockhash,
        instructions: instructions
    }).compileToV0Message(lookupTables);
    const simulation = await connection.simulateTransaction(
        new VersionedTransaction(messageV0)
    );

    const estimatedComputeUnits = simulation.value.unitsConsumed;
    const computeUnitLimit = estimatedComputeUnits 
        ? Math.ceil(estimatedComputeUnits * 1.3) 
        : DEFAULT_COMPUTE_UNIT_LIMIT;
    return computeUnitLimit;
}

export async function getComputerUnitLimitIx(
    connection: Connection,
    instructions: TransactionInstruction[],
    address: PublicKey,
    blockhash: string,
    lookupTables: AddressLookupTableAccount[] = []
) {
    const computeUnitLimit = await getComputeUnitLimit(connection, instructions, address, blockhash, lookupTables);
    return ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnitLimit,
    });
}
