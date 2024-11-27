import { AMM_RESERVE_PRECISION, AMM_RESERVE_PRECISION_EXP, BN, calculateAssetWeight, calculateLiabilityWeight, calculateLiveOracleTwap, calculateMarketMarginRatio, calculateMarketOpenBidAsk, calculatePerpLiabilityValue, calculatePositionPNL, calculateUnrealizedAssetWeight, calculateUnsettledFundingPnl, calculateWithdrawLimit, calculateWorstCasePerpLiabilityValue, DriftClient, fetchUserAccountsUsingKeys, FIVE_MINUTE, getSignedTokenAmount, getStrictTokenValue, getTokenAmount, getWorstCaseTokenAmounts, isSpotPositionAvailable, isVariant, MARGIN_PRECISION, MarginCategory, ONE, OPEN_ORDER_MARGIN_REQUIREMENT, PerpPosition, PRICE_PRECISION, QUOTE_PRECISION, QUOTE_SPOT_MARKET_INDEX, SPOT_MARKET_WEIGHT_PRECISION, SpotBalanceType, StrictOraclePrice, UserAccount, UserStatus, ZERO, TEN, divCeil, SpotMarketAccount } from "@drift-labs/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { getDriftUser } from "../utils/helpers.js";

export class DriftUser {
    private isInitialized: boolean = false;
    private authority: PublicKey;
    private connection: Connection;
    private driftClient: DriftClient;

    private userAccount: UserAccount | undefined;

    constructor (
        authority: PublicKey,
        connection: Connection, 
        driftClient: DriftClient
    ) {
        this.authority = authority;
        this.connection = connection;
        this.driftClient = driftClient;
    }

    public async initialize(): Promise<void> {
        const [ userAccount ] = await fetchUserAccountsUsingKeys(
            this.connection, 
            this.driftClient.program, 
            [getDriftUser(this.authority)]
        );
        if (!userAccount) throw new Error("Drift user not found");
        this.userAccount = userAccount;
        this.isInitialized = true;
    }

    public getHealth(): number{
        if (!this.isInitialized) throw new Error("DriftUser not initialized");

        if (this.isBeingLiquidated()) return 0;

        const totalCollateral = this.getTotalCollateral('Maintenance');
		const maintenanceMarginReq = this.getMaintenanceMarginRequirement();

		if (maintenanceMarginReq.eq(ZERO) && totalCollateral.gte(ZERO)) {
			return 100;
		}

		if (totalCollateral.lte(ZERO)) {
			return 0;
		}

		return Math.round(
			Math.min(
				100,
				Math.max(
					0,
					(1 - maintenanceMarginReq.toNumber() / totalCollateral.toNumber()) * 100
				)
			)
		);
    }

    public getTokenAmount(marketIndex: number): BN {
        if (!this.isInitialized) throw new Error("DriftUser not initialized");

		const spotPosition = this.userAccount!.spotPositions.find(
			(position) => position.marketIndex === marketIndex
		);

		if (spotPosition === undefined) {
			return ZERO;
		}

		const spotMarket = this.driftClient.getSpotMarketAccount(marketIndex)!;
		return getSignedTokenAmount(
			getTokenAmount(
				spotPosition.scaledBalance,
				spotMarket,
				spotPosition.balanceType
			),
			spotPosition.balanceType
		);
	}

	public getWithdrawalLimit(marketIndex: number, reduceOnly?: boolean): BN {
		const nowTs = new BN(Math.floor(Date.now() / 1000));
		const spotMarket = this.driftClient.getSpotMarketAccount(marketIndex);

		// eslint-disable-next-line prefer-const
		let { borrowLimit, withdrawLimit } = calculateWithdrawLimit(
			spotMarket!,
			nowTs
		);

		const freeCollateral = this.getFreeCollateral();
		const initialMarginRequirement = this.getMarginRequirement('Initial', undefined, false);
		const oracleData = this.driftClient.getOracleDataForSpotMarket(marketIndex);
		const precisionIncrease = TEN.pow(new BN(spotMarket!.decimals - 6));

		const { canBypass, depositAmount: userDepositAmount } =
			this.canBypassWithdrawLimits(marketIndex);
		if (canBypass) {
			withdrawLimit = BN.max(withdrawLimit, userDepositAmount);
		}

		const assetWeight = calculateAssetWeight(
			userDepositAmount,
			oracleData.price,
			spotMarket!,
			'Initial'
		);

		let amountWithdrawable;
		if (assetWeight.eq(ZERO)) {
			amountWithdrawable = userDepositAmount;
		} else if (initialMarginRequirement.eq(ZERO)) {
			amountWithdrawable = userDepositAmount;
		} else {
			amountWithdrawable = divCeil(
				divCeil(freeCollateral.mul(MARGIN_PRECISION), assetWeight).mul(
					PRICE_PRECISION
				),
				oracleData.price
			).mul(precisionIncrease);
		}

		const maxWithdrawValue = BN.min(
			BN.min(amountWithdrawable, userDepositAmount),
			withdrawLimit.abs()
		);

		if (reduceOnly) {
			return BN.max(maxWithdrawValue, ZERO);
		} else {
			const weightedAssetValue = this.getSpotMarketAssetValue(
				'Initial',
				marketIndex,
				false
			);

			const freeCollatAfterWithdraw = userDepositAmount.gt(ZERO)
				? freeCollateral.sub(weightedAssetValue)
				: freeCollateral;

			const maxLiabilityAllowed = freeCollatAfterWithdraw
				.mul(MARGIN_PRECISION)
				.div(new BN(spotMarket!.initialLiabilityWeight))
				.mul(PRICE_PRECISION)
				.div(oracleData.price)
				.mul(precisionIncrease);

			const maxBorrowValue = BN.min(
				maxWithdrawValue.add(maxLiabilityAllowed),
				borrowLimit.abs()
			);

			return BN.max(maxBorrowValue, ZERO);
		}
	}

	private getFreeCollateral(marginCategory: MarginCategory = 'Initial'): BN {
		const totalCollateral = this.getTotalCollateral(marginCategory, true);
		const marginRequirement =
			marginCategory === 'Initial'
				? this.getMarginRequirement('Initial', undefined, false)
				: this.getMaintenanceMarginRequirement();
		const freeCollateral = totalCollateral.sub(marginRequirement);
		return freeCollateral.gte(ZERO) ? freeCollateral : ZERO;
	}

	private canBypassWithdrawLimits(marketIndex: number): {
		canBypass: boolean;
		netDeposits: BN;
		depositAmount: BN;
		maxDepositAmount: BN;
	} {
		const spotMarket = this.driftClient.getSpotMarketAccount(marketIndex);
		const maxDepositAmount = spotMarket!.withdrawGuardThreshold.div(new BN(10));
		const position = this.userAccount!.spotPositions.find((position) => position.marketIndex === marketIndex);

		const netDeposits = this.userAccount!.totalDeposits.sub(
			this.userAccount!.totalWithdraws
		);

		if (!position) {
			return {
				canBypass: false,
				maxDepositAmount,
				depositAmount: ZERO,
				netDeposits,
			};
		}

		if (isVariant(position.balanceType, 'borrow')) {
			return {
				canBypass: false,
				maxDepositAmount,
				netDeposits,
				depositAmount: ZERO,
			};
		}

		const depositAmount = getTokenAmount(
			position.scaledBalance,
			spotMarket!,
			SpotBalanceType.DEPOSIT
		);

		if (netDeposits.lt(ZERO)) {
			return {
				canBypass: false,
				maxDepositAmount,
				depositAmount,
				netDeposits,
			};
		}

		return {
			canBypass: depositAmount.lt(maxDepositAmount),
			maxDepositAmount,
			netDeposits,
			depositAmount,
		};
	}

    private isBeingLiquidated(): boolean {
		return (
			(this.userAccount!.status &
				(UserStatus.BEING_LIQUIDATED | UserStatus.BANKRUPT)) >
			0
		);
	}

    private getTotalCollateral(
		marginCategory: MarginCategory = 'Initial',
		strict = false,
		includeOpenOrders = true
	): BN {
		return this.getSpotMarketAssetValue(
			marginCategory,
			undefined,
			includeOpenOrders,
			strict
		).add(this.getUnrealizedPNL(true, undefined, marginCategory, strict));
	}

    private getSpotMarketAssetValue(
		marginCategory: MarginCategory,
		marketIndex?: number,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		const { totalAssetValue } = this.getSpotMarketAssetAndLiabilityValue(
			marginCategory,
			marketIndex,
			undefined,
			includeOpenOrders,
			strict,
			now
		);
		return totalAssetValue;
	}

    private getSpotMarketAssetAndLiabilityValue(
		marginCategory: MarginCategory,
		marketIndex?: number,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): { totalAssetValue: BN; totalLiabilityValue: BN } {
		now = now || new BN(new Date().getTime() / 1000);
		let netQuoteValue = ZERO;
		let totalAssetValue = ZERO;
		let totalLiabilityValue = ZERO;
		for (const spotPosition of this.userAccount!.spotPositions) {
			const countForBase =
				marketIndex === undefined || spotPosition.marketIndex === marketIndex;

			const countForQuote =
				marketIndex === undefined ||
				marketIndex === QUOTE_SPOT_MARKET_INDEX ||
				(includeOpenOrders && spotPosition.openOrders !== 0);
			if (
				isSpotPositionAvailable(spotPosition) ||
				(!countForBase && !countForQuote)
			) {
				continue;
			}

			const spotMarketAccount: SpotMarketAccount =
				this.driftClient.getSpotMarketAccount(spotPosition.marketIndex)!;

			const oraclePriceData = this.driftClient.getOracleDataForSpotMarket(
				spotPosition.marketIndex
			);

			let twap5min;
			if (strict) {
				twap5min = calculateLiveOracleTwap(
					spotMarketAccount.historicalOracleData,
					oraclePriceData,
					now,
					FIVE_MINUTE // 5MIN
				);
			}
			const strictOraclePrice = new StrictOraclePrice(
				oraclePriceData.price,
				twap5min
			);

			if (
				spotPosition.marketIndex === QUOTE_SPOT_MARKET_INDEX &&
				countForQuote
			) {
				const tokenAmount = getSignedTokenAmount(
					getTokenAmount(
						spotPosition.scaledBalance,
						spotMarketAccount,
						spotPosition.balanceType
					),
					spotPosition.balanceType
				);

				if (isVariant(spotPosition.balanceType, 'borrow')) {
					const weightedTokenValue = this.getSpotLiabilityValue(
						tokenAmount,
						strictOraclePrice,
						spotMarketAccount,
						marginCategory,
						liquidationBuffer
					).abs();

					netQuoteValue = netQuoteValue.sub(weightedTokenValue);
				} else {
					const weightedTokenValue = this.getSpotAssetValue(
						tokenAmount,
						strictOraclePrice,
						spotMarketAccount,
						marginCategory
					);

					netQuoteValue = netQuoteValue.add(weightedTokenValue);
				}

				continue;
			}

			if (!includeOpenOrders && countForBase) {
				if (isVariant(spotPosition.balanceType, 'borrow')) {
					const tokenAmount = getSignedTokenAmount(
						getTokenAmount(
							spotPosition.scaledBalance,
							spotMarketAccount,
							spotPosition.balanceType
						),
						SpotBalanceType.BORROW
					);
					const liabilityValue = this.getSpotLiabilityValue(
						tokenAmount,
						strictOraclePrice,
						spotMarketAccount,
						marginCategory,
						liquidationBuffer
					).abs();
					totalLiabilityValue = totalLiabilityValue.add(liabilityValue);

					continue;
				} else {
					const tokenAmount = getTokenAmount(
						spotPosition.scaledBalance,
						spotMarketAccount,
						spotPosition.balanceType
					);
					const assetValue = this.getSpotAssetValue(
						tokenAmount,
						strictOraclePrice,
						spotMarketAccount,
						marginCategory
					);
					totalAssetValue = totalAssetValue.add(assetValue);

					continue;
				}
			}

			const {
				tokenAmount: worstCaseTokenAmount,
				ordersValue: worstCaseQuoteTokenAmount,
			} = getWorstCaseTokenAmounts(
				spotPosition,
				spotMarketAccount,
				strictOraclePrice,
				marginCategory,
				this.userAccount!.maxMarginRatio
			);

			if (worstCaseTokenAmount.gt(ZERO) && countForBase) {
				const baseAssetValue = this.getSpotAssetValue(
					worstCaseTokenAmount,
					strictOraclePrice,
					spotMarketAccount,
					marginCategory
				);

				totalAssetValue = totalAssetValue.add(baseAssetValue);
			}

			if (worstCaseTokenAmount.lt(ZERO) && countForBase) {
				const baseLiabilityValue = this.getSpotLiabilityValue(
					worstCaseTokenAmount,
					strictOraclePrice,
					spotMarketAccount,
					marginCategory,
					liquidationBuffer
				).abs();

				totalLiabilityValue = totalLiabilityValue.add(baseLiabilityValue);
			}

			if (worstCaseQuoteTokenAmount.gt(ZERO) && countForQuote) {
				netQuoteValue = netQuoteValue.add(worstCaseQuoteTokenAmount);
			}

			if (worstCaseQuoteTokenAmount.lt(ZERO) && countForQuote) {
				let weight = SPOT_MARKET_WEIGHT_PRECISION;
				if (marginCategory === 'Initial') {
					weight = BN.max(weight, new BN(this.userAccount!.maxMarginRatio));
				}

				const weightedTokenValue = worstCaseQuoteTokenAmount
					.abs()
					.mul(weight)
					.div(SPOT_MARKET_WEIGHT_PRECISION);

				netQuoteValue = netQuoteValue.sub(weightedTokenValue);
			}

			totalLiabilityValue = totalLiabilityValue.add(
				new BN(spotPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
			);
		}

		if (marketIndex === undefined || marketIndex === QUOTE_SPOT_MARKET_INDEX) {
			if (netQuoteValue.gt(ZERO)) {
				totalAssetValue = totalAssetValue.add(netQuoteValue);
			} else {
				totalLiabilityValue = totalLiabilityValue.add(netQuoteValue.abs());
			}
		}

		return { totalAssetValue, totalLiabilityValue };
	}

    private getSpotLiabilityValue(
		tokenAmount: BN,
		strictOraclePrice: StrictOraclePrice,
		spotMarketAccount: SpotMarketAccount,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN
	): BN {
		let liabilityValue = getStrictTokenValue(
			tokenAmount,
			spotMarketAccount.decimals,
			strictOraclePrice
		);

		if (marginCategory !== undefined) {
			let weight = calculateLiabilityWeight(
				tokenAmount,
				spotMarketAccount,
				marginCategory
			);

			if (
				marginCategory === 'Initial' &&
				spotMarketAccount.marketIndex !== QUOTE_SPOT_MARKET_INDEX
			) {
				weight = BN.max(
					weight,
					SPOT_MARKET_WEIGHT_PRECISION.addn(
						this.userAccount!.maxMarginRatio
					)
				);
			}

			if (liquidationBuffer !== undefined) {
				weight = weight.add(liquidationBuffer);
			}

			liabilityValue = liabilityValue
				.mul(weight)
				.div(SPOT_MARKET_WEIGHT_PRECISION);
		}

		return liabilityValue;
	}

    private getSpotAssetValue(
		tokenAmount: BN,
		strictOraclePrice: StrictOraclePrice,
		spotMarketAccount: SpotMarketAccount,
		marginCategory?: MarginCategory
	): BN {
		let assetValue = getStrictTokenValue(
			tokenAmount,
			spotMarketAccount.decimals,
			strictOraclePrice
		);

		if (marginCategory !== undefined) {
			let weight = calculateAssetWeight(
				tokenAmount,
				strictOraclePrice.current,
				spotMarketAccount,
				marginCategory
			);

			if (
				marginCategory === 'Initial' &&
				spotMarketAccount.marketIndex !== QUOTE_SPOT_MARKET_INDEX
			) {
				const userCustomAssetWeight = BN.max(
					ZERO,
					SPOT_MARKET_WEIGHT_PRECISION.subn(
						this.userAccount!.maxMarginRatio
					)
				);
				weight = BN.min(weight, userCustomAssetWeight);
			}

			assetValue = assetValue.mul(weight).div(SPOT_MARKET_WEIGHT_PRECISION);
		}

		return assetValue;
	}

    private getUnrealizedPNL(
		withFunding: boolean,
		marketIndex?: number,
		withWeightMarginCategory?: MarginCategory,
		strict = false
	): BN {
		return this.getActivePerpPositions()
			.filter((pos) =>
				marketIndex !== undefined ? pos.marketIndex === marketIndex : true
			)
			.reduce((unrealizedPnl, perpPosition) => {
				const market = this.driftClient.getPerpMarketAccount(
					perpPosition.marketIndex
				)!;
				const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(
					market.marketIndex
				);

				const quoteSpotMarket = this.driftClient.getSpotMarketAccount(
					market.quoteSpotMarketIndex
				)!;
				const quoteOraclePriceData = this.driftClient.getOracleDataForSpotMarket(
					market.quoteSpotMarketIndex
				);

				if (perpPosition.lpShares.gt(ZERO)) {
					perpPosition = this.getPerpPositionWithLPSettle(
						perpPosition.marketIndex,
						undefined,
						!!withWeightMarginCategory
					)[0];
				}

				let positionUnrealizedPnl = calculatePositionPNL(
					market,
					perpPosition,
					withFunding,
					oraclePriceData
				);

				let quotePrice;
				if (strict && positionUnrealizedPnl.gt(ZERO)) {
					quotePrice = BN.min(
						quoteOraclePriceData.price,
						quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
					);
				} else if (strict && positionUnrealizedPnl.lt(ZERO)) {
					quotePrice = BN.max(
						quoteOraclePriceData.price,
						quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
					);
				} else {
					quotePrice = quoteOraclePriceData.price;
				}

				positionUnrealizedPnl = positionUnrealizedPnl
					.mul(quotePrice)
					.div(PRICE_PRECISION);

				if (withWeightMarginCategory !== undefined) {
					if (positionUnrealizedPnl.gt(ZERO)) {
						positionUnrealizedPnl = positionUnrealizedPnl
							.mul(
								calculateUnrealizedAssetWeight(
									market,
									quoteSpotMarket,
									positionUnrealizedPnl,
									withWeightMarginCategory,
									oraclePriceData
								)
							)
							.div(new BN(SPOT_MARKET_WEIGHT_PRECISION));
					}
				}

				return unrealizedPnl.add(positionUnrealizedPnl);
			}, ZERO);
	}

    private getActivePerpPositions() {
        return this.userAccount!.perpPositions.filter(
			(pos) =>
				!pos.baseAssetAmount.eq(ZERO) ||
				!pos.quoteAssetAmount.eq(ZERO) ||
				!(pos.openOrders == 0) ||
				!pos.lpShares.eq(ZERO)
		);
    }

    private getPerpPositionWithLPSettle(
		marketIndex: number,
		originalPosition?: PerpPosition,
		burnLpShares = false,
		includeRemainderInBaseAmount = false
	): [PerpPosition, BN, BN] {
		originalPosition =
			originalPosition ??
			this.getPerpPosition(marketIndex) ??
			this.getEmptyPosition(marketIndex);

		if (originalPosition.lpShares.eq(ZERO)) {
			return [originalPosition, ZERO, ZERO];
		}

		const position = this.getClonedPosition(originalPosition);
		const market = this.driftClient.getPerpMarketAccount(position.marketIndex)!;

		if (market.amm.perLpBase != position.perLpBase) {
			// perLpBase = 1 => per 10 LP shares, perLpBase = -1 => per 0.1 LP shares
			const expoDiff = market.amm.perLpBase - position.perLpBase;
			const marketPerLpRebaseScalar = new BN(10 ** Math.abs(expoDiff));

			if (expoDiff > 0) {
				position.lastBaseAssetAmountPerLp =
					position.lastBaseAssetAmountPerLp.mul(marketPerLpRebaseScalar);
				position.lastQuoteAssetAmountPerLp =
					position.lastQuoteAssetAmountPerLp.mul(marketPerLpRebaseScalar);
			} else {
				position.lastBaseAssetAmountPerLp =
					position.lastBaseAssetAmountPerLp.div(marketPerLpRebaseScalar);
				position.lastQuoteAssetAmountPerLp =
					position.lastQuoteAssetAmountPerLp.div(marketPerLpRebaseScalar);
			}

			position.perLpBase = position.perLpBase + expoDiff;
		}

		const nShares = position.lpShares;

		// incorp unsettled funding on pre settled position
		const quoteFundingPnl = calculateUnsettledFundingPnl(market, position);

		let baseUnit = AMM_RESERVE_PRECISION;
		if (market.amm.perLpBase == position.perLpBase) {
			if (
				position.perLpBase >= 0 &&
				position.perLpBase <= AMM_RESERVE_PRECISION_EXP.toNumber()
			) {
				const marketPerLpRebase = new BN(10 ** market.amm.perLpBase);
				baseUnit = baseUnit.mul(marketPerLpRebase);
			} else if (
				position.perLpBase < 0 &&
				position.perLpBase >= -AMM_RESERVE_PRECISION_EXP.toNumber()
			) {
				const marketPerLpRebase = new BN(10 ** Math.abs(market.amm.perLpBase));
				baseUnit = baseUnit.div(marketPerLpRebase);
			} else {
				throw 'cannot calc';
			}
		} else {
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

		function sign(v: BN) {
			return v.isNeg() ? new BN(-1) : new BN(1);
		}

		function standardize(amount: BN, stepSize: BN) {
			const remainder = amount.abs().mod(stepSize).mul(sign(amount));
			const standardizedAmount = amount.sub(remainder);
			return [standardizedAmount, remainder];
		}

		const [standardizedBaa, remainderBaa] = standardize(
			deltaBaa,
			market.amm.orderStepSize
		);

		position.remainderBaseAssetAmount += remainderBaa.toNumber();

		if (
			Math.abs(position.remainderBaseAssetAmount) >
			market.amm.orderStepSize.toNumber()
		) {
			const [newStandardizedBaa, newRemainderBaa] = standardize(
				new BN(position.remainderBaseAssetAmount),
				market.amm.orderStepSize
			);
			position.baseAssetAmount =
				position.baseAssetAmount.add(newStandardizedBaa);
			position.remainderBaseAssetAmount = newRemainderBaa.toNumber();
		}

		let dustBaseAssetValue = ZERO;
		if (burnLpShares && position.remainderBaseAssetAmount != 0) {
			const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(
				position.marketIndex
			);
			dustBaseAssetValue = new BN(Math.abs(position.remainderBaseAssetAmount))
				.mul(oraclePriceData.price)
				.div(AMM_RESERVE_PRECISION)
				.add(ONE);
		}

		let updateType;
		if (position.baseAssetAmount.eq(ZERO)) {
			updateType = 'open';
		} else if (sign(position.baseAssetAmount).eq(sign(deltaBaa))) {
			updateType = 'increase';
		} else if (position.baseAssetAmount.abs().gt(deltaBaa.abs())) {
			updateType = 'reduce';
		} else if (position.baseAssetAmount.abs().eq(deltaBaa.abs())) {
			updateType = 'close';
		} else {
			updateType = 'flip';
		}

		let newQuoteEntry;
		let pnl;
		if (updateType == 'open' || updateType == 'increase') {
			newQuoteEntry = position.quoteEntryAmount.add(deltaQaa);
			pnl = ZERO;
		} else if (updateType == 'reduce' || updateType == 'close') {
			newQuoteEntry = position.quoteEntryAmount.sub(
				position.quoteEntryAmount
					.mul(deltaBaa.abs())
					.div(position.baseAssetAmount.abs())
			);
			pnl = position.quoteEntryAmount.sub(newQuoteEntry).add(deltaQaa);
		} else {
			newQuoteEntry = deltaQaa.sub(
				deltaQaa.mul(position.baseAssetAmount.abs()).div(deltaBaa.abs())
			);
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
		const [marketOpenBids, marketOpenAsks] = calculateMarketOpenBidAsk(
			market.amm.baseAssetReserve,
			market.amm.minBaseAssetReserve,
			market.amm.maxBaseAssetReserve,
			market.amm.orderStepSize
		);
		const lpOpenBids = marketOpenBids
			.mul(position.lpShares)
			.div(market.amm.sqrtK);
		const lpOpenAsks = marketOpenAsks
			.mul(position.lpShares)
			.div(market.amm.sqrtK);
		position.openBids = lpOpenBids.add(position.openBids);
		position.openAsks = lpOpenAsks.add(position.openAsks);

		// eliminate counting funding on settled position
		if (position.baseAssetAmount.gt(ZERO)) {
			position.lastCumulativeFundingRate = market.amm.cumulativeFundingRateLong;
		} else if (position.baseAssetAmount.lt(ZERO)) {
			position.lastCumulativeFundingRate =
				market.amm.cumulativeFundingRateShort;
		} else {
			position.lastCumulativeFundingRate = ZERO;
		}

		const remainderBeforeRemoval = new BN(position.remainderBaseAssetAmount);

		if (includeRemainderInBaseAmount) {
			position.baseAssetAmount = position.baseAssetAmount.add(
				remainderBeforeRemoval
			);
			position.remainderBaseAssetAmount = 0;
		}

		return [position, remainderBeforeRemoval, pnl];
	}

    private getPerpPosition(marketIndex: number): PerpPosition | undefined {
        const activePositions = this.userAccount!.perpPositions.filter(
			(pos) =>
				!pos.baseAssetAmount.eq(ZERO) ||
				!pos.quoteAssetAmount.eq(ZERO) ||
				!(pos.openOrders == 0) ||
				!pos.lpShares.eq(ZERO)
		);
        return activePositions.find(
			(position) => position.marketIndex === marketIndex
		);
    }

    private getEmptyPosition(marketIndex: number): PerpPosition {
		return {
			baseAssetAmount: ZERO,
			remainderBaseAssetAmount: 0,
			lastCumulativeFundingRate: ZERO,
			marketIndex,
			quoteAssetAmount: ZERO,
			quoteEntryAmount: ZERO,
			quoteBreakEvenAmount: ZERO,
			openOrders: 0,
			openBids: ZERO,
			openAsks: ZERO,
			settledPnl: ZERO,
			lpShares: ZERO,
			lastBaseAssetAmountPerLp: ZERO,
			lastQuoteAssetAmountPerLp: ZERO,
			perLpBase: 0,
		};
	}

    private getClonedPosition(position: PerpPosition): PerpPosition {
		const clonedPosition = Object.assign({}, position);
		return clonedPosition;
	}

    private getMaintenanceMarginRequirement(): BN {
		// if user being liq'd, can continue to be liq'd until total collateral above the margin requirement plus buffer
		let liquidationBuffer: BN | undefined = undefined;
		if (this.isBeingLiquidated()) {
			liquidationBuffer = new BN(
				this.driftClient.getStateAccount().liquidationMarginBufferRatio
			);
		}

		return this.getMarginRequirement('Maintenance', liquidationBuffer);
	}

    private getMarginRequirement(
		marginCategory: MarginCategory,
		liquidationBuffer?: BN,
		strict = false,
		includeOpenOrders = true
	): BN {
		return this.getTotalPerpPositionLiability(
			marginCategory,
			liquidationBuffer,
			includeOpenOrders,
			strict
		).add(
			this.getSpotMarketLiabilityValue(
                marginCategory,
				undefined,
				liquidationBuffer,
				includeOpenOrders,
				strict
			)
		);
	}

    private getTotalPerpPositionLiability(
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false
	): BN {
		return this.getActivePerpPositions().reduce(
			(totalPerpValue, perpPosition) => {
				const baseAssetValue = this.calculateWeightedPerpPositionLiability(
					perpPosition,
					marginCategory,
					liquidationBuffer,
					includeOpenOrders,
					strict
				);
				return totalPerpValue.add(baseAssetValue);
			},
			ZERO
		);
	}

    private calculateWeightedPerpPositionLiability(
		perpPosition: PerpPosition,
		marginCategory?: MarginCategory,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false
	): BN {
		const market = this.driftClient.getPerpMarketAccount(
			perpPosition.marketIndex
		)!;

		if (perpPosition.lpShares.gt(ZERO)) {
			// is an lp, clone so we dont mutate the position
			perpPosition = this.getPerpPositionWithLPSettle(
				market.marketIndex,
				this.getClonedPosition(perpPosition),
				!!marginCategory
			)[0];
		}

		let valuationPrice = this.driftClient.getOracleDataForPerpMarket(
			market.marketIndex
		).price;

		if (isVariant(market.status, 'settlement')) {
			valuationPrice = market.expiryPrice;
		}

		let baseAssetAmount: BN;
		let liabilityValue;
		if (includeOpenOrders) {
			const { worstCaseBaseAssetAmount, worstCaseLiabilityValue } =
				calculateWorstCasePerpLiabilityValue(
					perpPosition,
					market,
					valuationPrice
				);
			baseAssetAmount = worstCaseBaseAssetAmount;
			liabilityValue = worstCaseLiabilityValue;
		} else {
			baseAssetAmount = perpPosition.baseAssetAmount;
			liabilityValue = calculatePerpLiabilityValue(
				baseAssetAmount,
				valuationPrice,
				isVariant(market.contractType, 'prediction')
			);
		}

		if (marginCategory) {
			let marginRatio = new BN(
				calculateMarketMarginRatio(
					market,
					baseAssetAmount.abs(),
					marginCategory,
					this.userAccount!.maxMarginRatio,
					isVariant(this.userAccount!.marginMode, 'highLeverage')
				)
			);

			if (liquidationBuffer !== undefined) {
				marginRatio = marginRatio.add(liquidationBuffer);
			}

			if (isVariant(market.status, 'settlement')) {
				marginRatio = ZERO;
			}

			const quoteSpotMarket = this.driftClient.getSpotMarketAccount(
				market.quoteSpotMarketIndex
			)!;
			const quoteOraclePriceData = this.driftClient.getOracleDataForSpotMarket(
				QUOTE_SPOT_MARKET_INDEX
			);

			let quotePrice;
			if (strict) {
				quotePrice = BN.max(
					quoteOraclePriceData.price,
					quoteSpotMarket.historicalOracleData.lastOraclePriceTwap5Min
				);
			} else {
				quotePrice = quoteOraclePriceData.price;
			}

			liabilityValue = liabilityValue
				.mul(quotePrice)
				.div(PRICE_PRECISION)
				.mul(marginRatio)
				.div(MARGIN_PRECISION);

			if (includeOpenOrders) {
				liabilityValue = liabilityValue.add(
					new BN(perpPosition.openOrders).mul(OPEN_ORDER_MARGIN_REQUIREMENT)
				);

				if (perpPosition.lpShares.gt(ZERO)) {
					liabilityValue = liabilityValue.add(
						BN.max(
							QUOTE_PRECISION,
							valuationPrice
								.mul(market.amm.orderStepSize)
								.mul(QUOTE_PRECISION)
								.div(AMM_RESERVE_PRECISION)
								.div(PRICE_PRECISION)
						)
					);
				}
			}
		}

		return liabilityValue;
	}

    private getSpotMarketLiabilityValue(
		marginCategory: MarginCategory,
		marketIndex?: number,
		liquidationBuffer?: BN,
		includeOpenOrders?: boolean,
		strict = false,
		now?: BN
	): BN {
		const { totalLiabilityValue } = this.getSpotMarketAssetAndLiabilityValue(
            marginCategory,
			marketIndex,
			liquidationBuffer,
			includeOpenOrders,
			strict,
			now
		);
		return totalLiabilityValue;
	}
}
