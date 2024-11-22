"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriftUser = void 0;
const sdk_1 = require("@drift-labs/sdk");
const helpers_js_1 = require("./helpers.js");
class DriftUser {
    constructor(authority, connection, driftClient) {
        this.isInitialized = false;
        this.authority = authority;
        this.connection = connection;
        this.driftClient = driftClient;
    }
    initialize() {
        return __awaiter(this, void 0, void 0, function* () {
            const [userAccount] = yield (0, sdk_1.fetchUserAccountsUsingKeys)(this.connection, this.driftClient.program, [(0, helpers_js_1.getDriftUser)(this.authority)]);
            if (!userAccount)
                throw new Error("Drift user not found");
            this.userAccount = userAccount;
            this.isInitialized = true;
        });
    }
    getHealth() {
        if (!this.isInitialized)
            throw new Error("DriftUser not initialized");
        if (this.isBeingLiquidated())
            return 0;
        const totalCollateral = this.getTotalCollateral('Maintenance');
        const maintenanceMarginReq = this.getMaintenanceMarginRequirement();
        if (maintenanceMarginReq.eq(sdk_1.ZERO) && totalCollateral.gte(sdk_1.ZERO)) {
            return 100;
        }
        if (totalCollateral.lte(sdk_1.ZERO)) {
            return 0;
        }
        return Math.round(Math.min(100, Math.max(0, (1 - maintenanceMarginReq.toNumber() / totalCollateral.toNumber()) * 100)));
    }
    getTokenAmount(marketIndex) {
        if (!this.isInitialized)
            throw new Error("DriftUser not initialized");
        const spotPosition = this.userAccount.spotPositions.find((position) => position.marketIndex === marketIndex);
        if (spotPosition === undefined) {
            return sdk_1.ZERO;
        }
        const spotMarket = this.driftClient.getSpotMarketAccount(marketIndex);
        return (0, sdk_1.getSignedTokenAmount)((0, sdk_1.getTokenAmount)(spotPosition.scaledBalance, spotMarket, spotPosition.balanceType), spotPosition.balanceType);
    }
    isBeingLiquidated() {
        return ((this.userAccount.status &
            (sdk_1.UserStatus.BEING_LIQUIDATED | sdk_1.UserStatus.BANKRUPT)) >
            0);
    }
    getTotalCollateral(marginCategory = 'Initial', strict = false, includeOpenOrders = true) {
        return this.getSpotMarketAssetValue(marginCategory, undefined, includeOpenOrders, strict).add(this.getUnrealizedPNL(true, undefined, marginCategory, strict));
    }
    getSpotMarketAssetValue(marginCategory, marketIndex, includeOpenOrders, strict = false, now) {
        const { totalAssetValue } = this.getSpotMarketAssetAndLiabilityValue(marginCategory, marketIndex, undefined, includeOpenOrders, strict, now);
        return totalAssetValue;
    }
    getSpotMarketAssetAndLiabilityValue(marginCategory, marketIndex, liquidationBuffer, includeOpenOrders, strict = false, now) {
        now = now || new sdk_1.BN(new Date().getTime() / 1000);
        let netQuoteValue = sdk_1.ZERO;
        let totalAssetValue = sdk_1.ZERO;
        let totalLiabilityValue = sdk_1.ZERO;
        for (const spotPosition of this.userAccount.spotPositions) {
            const countForBase = marketIndex === undefined || spotPosition.marketIndex === marketIndex;
            const countForQuote = marketIndex === undefined ||
                marketIndex === sdk_1.QUOTE_SPOT_MARKET_INDEX ||
                (includeOpenOrders && spotPosition.openOrders !== 0);
            if ((0, sdk_1.isSpotPositionAvailable)(spotPosition) ||
                (!countForBase && !countForQuote)) {
                continue;
            }
            const spotMarketAccount = this.driftClient.getSpotMarketAccount(spotPosition.marketIndex);
            const oraclePriceData = this.driftClient.getOracleDataForSpotMarket(spotPosition.marketIndex);
            let twap5min;
            if (strict) {
                twap5min = (0, sdk_1.calculateLiveOracleTwap)(spotMarketAccount.historicalOracleData, oraclePriceData, now, sdk_1.FIVE_MINUTE // 5MIN
                );
            }
            const strictOraclePrice = new sdk_1.StrictOraclePrice(oraclePriceData.price, twap5min);
            if (spotPosition.marketIndex === sdk_1.QUOTE_SPOT_MARKET_INDEX &&
                countForQuote) {
                const tokenAmount = (0, sdk_1.getSignedTokenAmount)((0, sdk_1.getTokenAmount)(spotPosition.scaledBalance, spotMarketAccount, spotPosition.balanceType), spotPosition.balanceType);
                if ((0, sdk_1.isVariant)(spotPosition.balanceType, 'borrow')) {
                    const weightedTokenValue = this.getSpotLiabilityValue(tokenAmount, strictOraclePrice, spotMarketAccount, marginCategory, liquidationBuffer).abs();
                    netQuoteValue = netQuoteValue.sub(weightedTokenValue);
                }
                else {
                    const weightedTokenValue = this.getSpotAssetValue(tokenAmount, strictOraclePrice, spotMarketAccount, marginCategory);
                    netQuoteValue = netQuoteValue.add(weightedTokenValue);
                }
                continue;
            }
            if (!includeOpenOrders && countForBase) {
                if ((0, sdk_1.isVariant)(spotPosition.balanceType, 'borrow')) {
                    const tokenAmount = (0, sdk_1.getSignedTokenAmount)((0, sdk_1.getTokenAmount)(spotPosition.scaledBalance, spotMarketAccount, spotPosition.balanceType), sdk_1.SpotBalanceType.BORROW);
                    const liabilityValue = this.getSpotLiabilityValue(tokenAmount, strictOraclePrice, spotMarketAccount, marginCategory, liquidationBuffer).abs();
                    totalLiabilityValue = totalLiabilityValue.add(liabilityValue);
                    continue;
                }
                else {
                    const tokenAmount = (0, sdk_1.getTokenAmount)(spotPosition.scaledBalance, spotMarketAccount, spotPosition.balanceType);
                    const assetValue = this.getSpotAssetValue(tokenAmount, strictOraclePrice, spotMarketAccount, marginCategory);
                    totalAssetValue = totalAssetValue.add(assetValue);
                    continue;
                }
            }
            const { tokenAmount: worstCaseTokenAmount, ordersValue: worstCaseQuoteTokenAmount, } = (0, sdk_1.getWorstCaseTokenAmounts)(spotPosition, spotMarketAccount, strictOraclePrice, marginCategory, this.userAccount.maxMarginRatio);
            if (worstCaseTokenAmount.gt(sdk_1.ZERO) && countForBase) {
                const baseAssetValue = this.getSpotAssetValue(worstCaseTokenAmount, strictOraclePrice, spotMarketAccount, marginCategory);
                totalAssetValue = totalAssetValue.add(baseAssetValue);
            }
            if (worstCaseTokenAmount.lt(sdk_1.ZERO) && countForBase) {
                const baseLiabilityValue = this.getSpotLiabilityValue(worstCaseTokenAmount, strictOraclePrice, spotMarketAccount, marginCategory, liquidationBuffer).abs();
                totalLiabilityValue = totalLiabilityValue.add(baseLiabilityValue);
            }
            if (worstCaseQuoteTokenAmount.gt(sdk_1.ZERO) && countForQuote) {
                netQuoteValue = netQuoteValue.add(worstCaseQuoteTokenAmount);
            }
            if (worstCaseQuoteTokenAmount.lt(sdk_1.ZERO) && countForQuote) {
                let weight = sdk_1.SPOT_MARKET_WEIGHT_PRECISION;
                if (marginCategory === 'Initial') {
                    weight = sdk_1.BN.max(weight, new sdk_1.BN(this.userAccount.maxMarginRatio));
                }
                const weightedTokenValue = worstCaseQuoteTokenAmount
                    .abs()
                    .mul(weight)
                    .div(sdk_1.SPOT_MARKET_WEIGHT_PRECISION);
                netQuoteValue = netQuoteValue.sub(weightedTokenValue);
            }
            totalLiabilityValue = totalLiabilityValue.add(new sdk_1.BN(spotPosition.openOrders).mul(sdk_1.OPEN_ORDER_MARGIN_REQUIREMENT));
        }
        if (marketIndex === undefined || marketIndex === sdk_1.QUOTE_SPOT_MARKET_INDEX) {
            if (netQuoteValue.gt(sdk_1.ZERO)) {
                totalAssetValue = totalAssetValue.add(netQuoteValue);
            }
            else {
                totalLiabilityValue = totalLiabilityValue.add(netQuoteValue.abs());
            }
        }
        return { totalAssetValue, totalLiabilityValue };
    }
    getSpotLiabilityValue(tokenAmount, strictOraclePrice, spotMarketAccount, marginCategory, liquidationBuffer) {
        let liabilityValue = (0, sdk_1.getStrictTokenValue)(tokenAmount, spotMarketAccount.decimals, strictOraclePrice);
        if (marginCategory !== undefined) {
            let weight = (0, sdk_1.calculateLiabilityWeight)(tokenAmount, spotMarketAccount, marginCategory);
            if (marginCategory === 'Initial' &&
                spotMarketAccount.marketIndex !== sdk_1.QUOTE_SPOT_MARKET_INDEX) {
                weight = sdk_1.BN.max(weight, sdk_1.SPOT_MARKET_WEIGHT_PRECISION.addn(this.userAccount.maxMarginRatio));
            }
            if (liquidationBuffer !== undefined) {
                weight = weight.add(liquidationBuffer);
            }
            liabilityValue = liabilityValue
                .mul(weight)
                .div(sdk_1.SPOT_MARKET_WEIGHT_PRECISION);
        }
        return liabilityValue;
    }
    getSpotAssetValue(tokenAmount, strictOraclePrice, spotMarketAccount, marginCategory) {
        let assetValue = (0, sdk_1.getStrictTokenValue)(tokenAmount, spotMarketAccount.decimals, strictOraclePrice);
        if (marginCategory !== undefined) {
            let weight = (0, sdk_1.calculateAssetWeight)(tokenAmount, strictOraclePrice.current, spotMarketAccount, marginCategory);
            if (marginCategory === 'Initial' &&
                spotMarketAccount.marketIndex !== sdk_1.QUOTE_SPOT_MARKET_INDEX) {
                const userCustomAssetWeight = sdk_1.BN.max(sdk_1.ZERO, sdk_1.SPOT_MARKET_WEIGHT_PRECISION.subn(this.userAccount.maxMarginRatio));
                weight = sdk_1.BN.min(weight, userCustomAssetWeight);
            }
            assetValue = assetValue.mul(weight).div(sdk_1.SPOT_MARKET_WEIGHT_PRECISION);
        }
        return assetValue;
    }
    getUnrealizedPNL(withFunding, marketIndex, withWeightMarginCategory, strict = false) {
        return this.getActivePerpPositions()
            .filter((pos) => marketIndex !== undefined ? pos.marketIndex === marketIndex : true)
            .reduce((unrealizedPnl, perpPosition) => {
            const market = this.driftClient.getPerpMarketAccount(perpPosition.marketIndex);
            const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(market.marketIndex);
            const quoteSpotMarket = this.driftClient.getSpotMarketAccount(market.quoteSpotMarketIndex);
            const quoteOraclePriceData = this.driftClient.getOracleDataForSpotMarket(market.quoteSpotMarketIndex);
            if (perpPosition.lpShares.gt(sdk_1.ZERO)) {
                perpPosition = this.getPerpPositionWithLPSettle(perpPosition.marketIndex, undefined, !!withWeightMarginCategory)[0];
            }
            let positionUnrealizedPnl = (0, sdk_1.calculatePositionPNL)(market, perpPosition, withFunding, oraclePriceData);
            let quotePrice;
            if (strict && positionUnrealizedPnl.gt(sdk_1.ZERO)) {
                quotePrice = sdk_1.BN.min(quoteOraclePriceData.price, quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min);
            }
            else if (strict && positionUnrealizedPnl.lt(sdk_1.ZERO)) {
                quotePrice = sdk_1.BN.max(quoteOraclePriceData.price, quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min);
            }
            else {
                quotePrice = quoteOraclePriceData.price;
            }
            positionUnrealizedPnl = positionUnrealizedPnl
                .mul(quotePrice)
                .div(sdk_1.PRICE_PRECISION);
            if (withWeightMarginCategory !== undefined) {
                if (positionUnrealizedPnl.gt(sdk_1.ZERO)) {
                    positionUnrealizedPnl = positionUnrealizedPnl
                        .mul((0, sdk_1.calculateUnrealizedAssetWeight)(market, quoteSpotMarket, positionUnrealizedPnl, withWeightMarginCategory, oraclePriceData))
                        .div(new sdk_1.BN(sdk_1.SPOT_MARKET_WEIGHT_PRECISION));
                }
            }
            return unrealizedPnl.add(positionUnrealizedPnl);
        }, sdk_1.ZERO);
    }
    getActivePerpPositions() {
        return this.userAccount.perpPositions.filter((pos) => !pos.baseAssetAmount.eq(sdk_1.ZERO) ||
            !pos.quoteAssetAmount.eq(sdk_1.ZERO) ||
            !(pos.openOrders == 0) ||
            !pos.lpShares.eq(sdk_1.ZERO));
    }
    getPerpPositionWithLPSettle(marketIndex, originalPosition, burnLpShares = false, includeRemainderInBaseAmount = false) {
        var _a;
        originalPosition =
            (_a = originalPosition !== null && originalPosition !== void 0 ? originalPosition : this.getPerpPosition(marketIndex)) !== null && _a !== void 0 ? _a : this.getEmptyPosition(marketIndex);
        if (originalPosition.lpShares.eq(sdk_1.ZERO)) {
            return [originalPosition, sdk_1.ZERO, sdk_1.ZERO];
        }
        const position = this.getClonedPosition(originalPosition);
        const market = this.driftClient.getPerpMarketAccount(position.marketIndex);
        if (market.amm.perLpBase != position.perLpBase) {
            // perLpBase = 1 => per 10 LP shares, perLpBase = -1 => per 0.1 LP shares
            const expoDiff = market.amm.perLpBase - position.perLpBase;
            const marketPerLpRebaseScalar = new sdk_1.BN(10 ** Math.abs(expoDiff));
            if (expoDiff > 0) {
                position.lastBaseAssetAmountPerLp =
                    position.lastBaseAssetAmountPerLp.mul(marketPerLpRebaseScalar);
                position.lastQuoteAssetAmountPerLp =
                    position.lastQuoteAssetAmountPerLp.mul(marketPerLpRebaseScalar);
            }
            else {
                position.lastBaseAssetAmountPerLp =
                    position.lastBaseAssetAmountPerLp.div(marketPerLpRebaseScalar);
                position.lastQuoteAssetAmountPerLp =
                    position.lastQuoteAssetAmountPerLp.div(marketPerLpRebaseScalar);
            }
            position.perLpBase = position.perLpBase + expoDiff;
        }
        const nShares = position.lpShares;
        // incorp unsettled funding on pre settled position
        const quoteFundingPnl = (0, sdk_1.calculateUnsettledFundingPnl)(market, position);
        let baseUnit = sdk_1.AMM_RESERVE_PRECISION;
        if (market.amm.perLpBase == position.perLpBase) {
            if (position.perLpBase >= 0 &&
                position.perLpBase <= sdk_1.AMM_RESERVE_PRECISION_EXP.toNumber()) {
                const marketPerLpRebase = new sdk_1.BN(10 ** market.amm.perLpBase);
                baseUnit = baseUnit.mul(marketPerLpRebase);
            }
            else if (position.perLpBase < 0 &&
                position.perLpBase >= -sdk_1.AMM_RESERVE_PRECISION_EXP.toNumber()) {
                const marketPerLpRebase = new sdk_1.BN(10 ** Math.abs(market.amm.perLpBase));
                baseUnit = baseUnit.div(marketPerLpRebase);
            }
            else {
                throw 'cannot calc';
            }
        }
        else {
            throw 'market.amm.perLpBase != position.perLpBase';
        }
        const deltaBaa = market.amm.baseAssetAmountPerLp
            .sub(position.lastBaseAssetAmountPerLp)
            .mul(nShares)
            .div(baseUnit);
        const deltaQaa = market.amm.quoteAssetAmountPerLp
            .sub(position.lastQuoteAssetAmountPerLp)
            .mul(nShares)
            .div(baseUnit);
        function sign(v) {
            return v.isNeg() ? new sdk_1.BN(-1) : new sdk_1.BN(1);
        }
        function standardize(amount, stepSize) {
            const remainder = amount.abs().mod(stepSize).mul(sign(amount));
            const standardizedAmount = amount.sub(remainder);
            return [standardizedAmount, remainder];
        }
        const [standardizedBaa, remainderBaa] = standardize(deltaBaa, market.amm.orderStepSize);
        position.remainderBaseAssetAmount += remainderBaa.toNumber();
        if (Math.abs(position.remainderBaseAssetAmount) >
            market.amm.orderStepSize.toNumber()) {
            const [newStandardizedBaa, newRemainderBaa] = standardize(new sdk_1.BN(position.remainderBaseAssetAmount), market.amm.orderStepSize);
            position.baseAssetAmount =
                position.baseAssetAmount.add(newStandardizedBaa);
            position.remainderBaseAssetAmount = newRemainderBaa.toNumber();
        }
        let dustBaseAssetValue = sdk_1.ZERO;
        if (burnLpShares && position.remainderBaseAssetAmount != 0) {
            const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(position.marketIndex);
            dustBaseAssetValue = new sdk_1.BN(Math.abs(position.remainderBaseAssetAmount))
                .mul(oraclePriceData.price)
                .div(sdk_1.AMM_RESERVE_PRECISION)
                .add(sdk_1.ONE);
        }
        let updateType;
        if (position.baseAssetAmount.eq(sdk_1.ZERO)) {
            updateType = 'open';
        }
        else if (sign(position.baseAssetAmount).eq(sign(deltaBaa))) {
            updateType = 'increase';
        }
        else if (position.baseAssetAmount.abs().gt(deltaBaa.abs())) {
            updateType = 'reduce';
        }
        else if (position.baseAssetAmount.abs().eq(deltaBaa.abs())) {
            updateType = 'close';
        }
        else {
            updateType = 'flip';
        }
        let newQuoteEntry;
        let pnl;
        if (updateType == 'open' || updateType == 'increase') {
            newQuoteEntry = position.quoteEntryAmount.add(deltaQaa);
            pnl = sdk_1.ZERO;
        }
        else if (updateType == 'reduce' || updateType == 'close') {
            newQuoteEntry = position.quoteEntryAmount.sub(position.quoteEntryAmount
                .mul(deltaBaa.abs())
                .div(position.baseAssetAmount.abs()));
            pnl = position.quoteEntryAmount.sub(newQuoteEntry).add(deltaQaa);
        }
        else {
            newQuoteEntry = deltaQaa.sub(deltaQaa.mul(position.baseAssetAmount.abs()).div(deltaBaa.abs()));
            pnl = position.quoteEntryAmount.add(deltaQaa.sub(newQuoteEntry));
        }
        position.quoteEntryAmount = newQuoteEntry;
        position.baseAssetAmount = position.baseAssetAmount.add(standardizedBaa);
        position.quoteAssetAmount = position.quoteAssetAmount
            .add(deltaQaa)
            .add(quoteFundingPnl)
            .sub(dustBaseAssetValue);
        position.quoteBreakEvenAmount = position.quoteBreakEvenAmount
            .add(deltaQaa)
            .add(quoteFundingPnl)
            .sub(dustBaseAssetValue);
        // update open bids/asks
        const [marketOpenBids, marketOpenAsks] = (0, sdk_1.calculateMarketOpenBidAsk)(market.amm.baseAssetReserve, market.amm.minBaseAssetReserve, market.amm.maxBaseAssetReserve, market.amm.orderStepSize);
        const lpOpenBids = marketOpenBids
            .mul(position.lpShares)
            .div(market.amm.sqrtK);
        const lpOpenAsks = marketOpenAsks
            .mul(position.lpShares)
            .div(market.amm.sqrtK);
        position.openBids = lpOpenBids.add(position.openBids);
        position.openAsks = lpOpenAsks.add(position.openAsks);
        // eliminate counting funding on settled position
        if (position.baseAssetAmount.gt(sdk_1.ZERO)) {
            position.lastCumulativeFundingRate = market.amm.cumulativeFundingRateLong;
        }
        else if (position.baseAssetAmount.lt(sdk_1.ZERO)) {
            position.lastCumulativeFundingRate =
                market.amm.cumulativeFundingRateShort;
        }
        else {
            position.lastCumulativeFundingRate = sdk_1.ZERO;
        }
        const remainderBeforeRemoval = new sdk_1.BN(position.remainderBaseAssetAmount);
        if (includeRemainderInBaseAmount) {
            position.baseAssetAmount = position.baseAssetAmount.add(remainderBeforeRemoval);
            position.remainderBaseAssetAmount = 0;
        }
        return [position, remainderBeforeRemoval, pnl];
    }
    getPerpPosition(marketIndex) {
        const activePositions = this.userAccount.perpPositions.filter((pos) => !pos.baseAssetAmount.eq(sdk_1.ZERO) ||
            !pos.quoteAssetAmount.eq(sdk_1.ZERO) ||
            !(pos.openOrders == 0) ||
            !pos.lpShares.eq(sdk_1.ZERO));
        return activePositions.find((position) => position.marketIndex === marketIndex);
    }
    getEmptyPosition(marketIndex) {
        return {
            baseAssetAmount: sdk_1.ZERO,
            remainderBaseAssetAmount: 0,
            lastCumulativeFundingRate: sdk_1.ZERO,
            marketIndex,
            quoteAssetAmount: sdk_1.ZERO,
            quoteEntryAmount: sdk_1.ZERO,
            quoteBreakEvenAmount: sdk_1.ZERO,
            openOrders: 0,
            openBids: sdk_1.ZERO,
            openAsks: sdk_1.ZERO,
            settledPnl: sdk_1.ZERO,
            lpShares: sdk_1.ZERO,
            lastBaseAssetAmountPerLp: sdk_1.ZERO,
            lastQuoteAssetAmountPerLp: sdk_1.ZERO,
            perLpBase: 0,
        };
    }
    getClonedPosition(position) {
        const clonedPosition = Object.assign({}, position);
        return clonedPosition;
    }
    getMaintenanceMarginRequirement() {
        // if user being liq'd, can continue to be liq'd until total collateral above the margin requirement plus buffer
        let liquidationBuffer = undefined;
        if (this.isBeingLiquidated()) {
            liquidationBuffer = new sdk_1.BN(this.driftClient.getStateAccount().liquidationMarginBufferRatio);
        }
        return this.getMarginRequirement('Maintenance', liquidationBuffer);
    }
    getMarginRequirement(marginCategory, liquidationBuffer, strict = false, includeOpenOrders = true) {
        return this.getTotalPerpPositionLiability(marginCategory, liquidationBuffer, includeOpenOrders, strict).add(this.getSpotMarketLiabilityValue(marginCategory, undefined, liquidationBuffer, includeOpenOrders, strict));
    }
    getTotalPerpPositionLiability(marginCategory, liquidationBuffer, includeOpenOrders, strict = false) {
        return this.getActivePerpPositions().reduce((totalPerpValue, perpPosition) => {
            const baseAssetValue = this.calculateWeightedPerpPositionLiability(perpPosition, marginCategory, liquidationBuffer, includeOpenOrders, strict);
            return totalPerpValue.add(baseAssetValue);
        }, sdk_1.ZERO);
    }
    calculateWeightedPerpPositionLiability(perpPosition, marginCategory, liquidationBuffer, includeOpenOrders, strict = false) {
        const market = this.driftClient.getPerpMarketAccount(perpPosition.marketIndex);
        if (perpPosition.lpShares.gt(sdk_1.ZERO)) {
            // is an lp, clone so we dont mutate the position
            perpPosition = this.getPerpPositionWithLPSettle(market.marketIndex, this.getClonedPosition(perpPosition), !!marginCategory)[0];
        }
        let valuationPrice = this.driftClient.getOracleDataForPerpMarket(market.marketIndex).price;
        if ((0, sdk_1.isVariant)(market.status, 'settlement')) {
            valuationPrice = market.expiryPrice;
        }
        let baseAssetAmount;
        let liabilityValue;
        if (includeOpenOrders) {
            const { worstCaseBaseAssetAmount, worstCaseLiabilityValue } = (0, sdk_1.calculateWorstCasePerpLiabilityValue)(perpPosition, market, valuationPrice);
            baseAssetAmount = worstCaseBaseAssetAmount;
            liabilityValue = worstCaseLiabilityValue;
        }
        else {
            baseAssetAmount = perpPosition.baseAssetAmount;
            liabilityValue = (0, sdk_1.calculatePerpLiabilityValue)(baseAssetAmount, valuationPrice, (0, sdk_1.isVariant)(market.contractType, 'prediction'));
        }
        if (marginCategory) {
            let marginRatio = new sdk_1.BN((0, sdk_1.calculateMarketMarginRatio)(market, baseAssetAmount.abs(), marginCategory, this.userAccount.maxMarginRatio, (0, sdk_1.isVariant)(this.userAccount.marginMode, 'highLeverage')));
            if (liquidationBuffer !== undefined) {
                marginRatio = marginRatio.add(liquidationBuffer);
            }
            if ((0, sdk_1.isVariant)(market.status, 'settlement')) {
                marginRatio = sdk_1.ZERO;
            }
            const quoteSpotMarket = this.driftClient.getSpotMarketAccount(market.quoteSpotMarketIndex);
            const quoteOraclePriceData = this.driftClient.getOracleDataForSpotMarket(sdk_1.QUOTE_SPOT_MARKET_INDEX);
            let quotePrice;
            if (strict) {
                quotePrice = sdk_1.BN.max(quoteOraclePriceData.price, quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min);
            }
            else {
                quotePrice = quoteOraclePriceData.price;
            }
            liabilityValue = liabilityValue
                .mul(quotePrice)
                .div(sdk_1.PRICE_PRECISION)
                .mul(marginRatio)
                .div(sdk_1.MARGIN_PRECISION);
            if (includeOpenOrders) {
                liabilityValue = liabilityValue.add(new sdk_1.BN(perpPosition.openOrders).mul(sdk_1.OPEN_ORDER_MARGIN_REQUIREMENT));
                if (perpPosition.lpShares.gt(sdk_1.ZERO)) {
                    liabilityValue = liabilityValue.add(sdk_1.BN.max(sdk_1.QUOTE_PRECISION, valuationPrice
                        .mul(market.amm.orderStepSize)
                        .mul(sdk_1.QUOTE_PRECISION)
                        .div(sdk_1.AMM_RESERVE_PRECISION)
                        .div(sdk_1.PRICE_PRECISION)));
                }
            }
        }
        return liabilityValue;
    }
    getSpotMarketLiabilityValue(marginCategory, marketIndex, liquidationBuffer, includeOpenOrders, strict = false, now) {
        const { totalLiabilityValue } = this.getSpotMarketAssetAndLiabilityValue(marginCategory, marketIndex, liquidationBuffer, includeOpenOrders, strict, now);
        return totalLiabilityValue;
    }
}
exports.DriftUser = DriftUser;
