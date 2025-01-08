import { type Connection, ComputeBudgetProgram, type PublicKey } from "@solana/web3.js";
import type { Logger } from "winston";
import type { QuoteResponse } from "@jup-ag/api";
import { MarketIndex, TOKENS, type BN, type QuartzUser } from "@quartz-labs/sdk";
import type { PythResponse } from "../types/pyth.interface.js";

export async function getJupiterSwapQuote(
    inputMint: PublicKey, 
    outputMint: PublicKey, 
    amount: number,
    slippageBps: number
) {
    const quoteEndpoint = 
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=${slippageBps}&swapMode=ExactOut&onlyDirectRoutes=true`;
    const quoteResponse = await (await fetch(quoteEndpoint)).json() as QuoteResponse;
    return quoteResponse;
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

export const createPriorityFeeInstructions = async (computeBudget: number) => {
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: computeBudget,
    });
    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: await 1_000_000 // TODO: Implement fetching priority fee
    });
    return [computeLimitIx, computePriceIx];
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

export function getLowestValue(values: Record<MarketIndex, number>): MarketIndex {
    let lowestValue = Number.MAX_VALUE;
    let lowestValueIndex: MarketIndex = MarketIndex[0];

    for (const [marketIndex, value] of Object.entries(values)) {
        const numericValue = value;
        if (numericValue < lowestValue) {
            lowestValue = numericValue;
            lowestValueIndex = Number(marketIndex) as MarketIndex;
        }
    }
    return lowestValueIndex;
}

export function getHighestValue(values: Record<MarketIndex, number>): MarketIndex {
    let highestValue = Number.MIN_VALUE;
    let highestValueIndex: MarketIndex = MarketIndex[0];

    for (const [marketIndex, value] of Object.entries(values)) {
        const numericValue = value;
        if (numericValue > highestValue) {
            highestValue = numericValue;
            highestValueIndex = Number(marketIndex) as MarketIndex;
        }
    }
    
    return highestValueIndex;
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
