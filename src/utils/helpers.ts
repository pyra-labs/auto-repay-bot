import { SwapMode } from "@jup-ag/api";
import { baseUnitToDecimal, decimalToBaseUnit, MARKET_INDEX_USDC, MarketIndex, retryWithBackoff, TOKENS, type BN, type QuartzUser } from "@quartz-labs/sdk";
import type { Connection, PublicKey, SendTransactionError } from "@solana/web3.js";
import type { PythResponse } from "../types/Pyth.interface.js";
import type { Position } from "../types/Position.interface.js";
import { JUPITER_SLIPPAGE_BPS, SLIPPAGE_ERROR_CODES } from "../config/constants.js";
import { getJupiterSwapQuote } from "./jupiter.js";

export async function fetchExactOutParams(
    marketIndexCollateral: MarketIndex,
    marketIndexLoan: MarketIndex,
    loanRepayUsdcValue: number,
    loanPrice: number,
    collateralPrice: number,
    collateralBalance: number,
) {
    // Ensure the collateral required for the loan repay is not higher than the collateral balance
    const collateralBalanceValue = baseUnitToDecimal(collateralBalance, marketIndexCollateral) * collateralPrice;
    const loanEquivalentDecimal = (collateralBalanceValue / loanPrice) * (1 - JUPITER_SLIPPAGE_BPS / 10_000);
    const loanEquivalentBaseUnits = decimalToBaseUnit(loanEquivalentDecimal, marketIndexLoan);

    const loanRepayValue = baseUnitToDecimal(loanRepayUsdcValue, MARKET_INDEX_USDC);
    const targetRepayAmountLoanBaseUnits = decimalToBaseUnit(loanRepayValue / loanPrice, marketIndexLoan);
    
    const repayAmountLoan = Math.min(targetRepayAmountLoanBaseUnits, loanEquivalentBaseUnits);
    
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
    loanRepayUsdcValue: number,
    collateralPrice: number,
    collateralBalance: number
) {
    const loanRepayValue = baseUnitToDecimal(loanRepayUsdcValue, MARKET_INDEX_USDC);
    const targetRepayAmountCollateralDecimal = loanRepayValue / collateralPrice;
    const targetRepayAmountCollateralBaseUnits = decimalToBaseUnit(targetRepayAmountCollateralDecimal, marketIndexCollateral);
    const repayAmountCollateral = Math.min(targetRepayAmountCollateralBaseUnits, collateralBalance);

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

export async function getTokenAccountBalance(connection: Connection, tokenAccount: PublicKey) {
    const account = await retryWithBackoff(
        async () => connection.getAccountInfo(tokenAccount)
    )
    if (account === null) return 0;
    
    const balance = await retryWithBackoff(
        async () => connection.getTokenAccountBalance(tokenAccount)
    )
    return Number(balance.value.amount);
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
        Object.entries(balances).map(([index, balance]) =>{
            const marketIndex = Number(index) as MarketIndex;
            const balanceDecimal = baseUnitToDecimal(balance.toNumber(), marketIndex);
            const valueDollars = prices[marketIndex] * balanceDecimal;
            let valueUsdc = decimalToBaseUnit(valueDollars, MARKET_INDEX_USDC);

            // 1 base unit of another stablecoin may convert to less than 1 base unit of USDC due to price fluctuations
            if (valueDollars > 0 && valueUsdc === 0) {
                valueUsdc = 1;
            } else if (valueDollars < 0 && valueUsdc === 0) {
                valueUsdc = -1;
            }

            return [ marketIndex, valueUsdc ];
        })
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

export async function isSlippageError(error: SendTransactionError, connection: Connection) {
    const baseError = "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: ";
    const slippageErrors = SLIPPAGE_ERROR_CODES.map(code => `${baseError}${code}`);
    const logs = await error.getLogs(connection);

    return logs.some(
        log => slippageErrors.some(
            error => log.includes(error) // Check if any slippage errors are contained in any logs
        )
    );
}
