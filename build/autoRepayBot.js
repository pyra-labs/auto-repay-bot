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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AutoRepayBot = void 0;
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const sdk_1 = require("@drift-labs/sdk");
const marginfi_client_v2_1 = require("@mrgnlabs/marginfi-client-v2");
const spl_token_1 = require("@solana/spl-token");
const constants_js_1 = require("./constants.js");
const helpers_js_1 = require("./helpers.js");
const helpers_js_2 = require("./helpers.js");
const pyth_solana_receiver_1 = require("@pythnetwork/pyth-solana-receiver");
const jupiter_js_1 = require("./jupiter.js");
const bignumber_js_1 = __importDefault(require("bignumber.js"));
const driftUser_js_1 = require("./driftUser.js");
class AutoRepayBot {
    constructor(connection, wallet, program, maxRetries) {
        this.isInitialized = false;
        this.driftState = (0, helpers_js_1.getDriftState)();
        this.driftSpotMarketSol = (0, helpers_js_2.getDriftSpotMarketVault)(constants_js_1.DRIFT_MARKET_INDEX_SOL);
        this.driftSpotMarketUsdc = (0, helpers_js_2.getDriftSpotMarketVault)(constants_js_1.DRIFT_MARKET_INDEX_USDC);
        this.connection = connection;
        this.wallet = wallet;
        this.program = program;
        this.maxRetries = maxRetries;
    }
    initialize() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const quartzLookupTable = yield this.connection.getAddressLookupTable(constants_js_1.QUARTZ_ADDRESS_TABLE).then((res) => res.value);
            if (!quartzLookupTable)
                throw Error("Address Lookup Table account not found");
            this.quartzLookupTable = quartzLookupTable;
            // Initialize ATAs
            this.walletUsdc = yield (0, spl_token_1.getOrCreateAssociatedTokenAccount)(this.connection, this.wallet.payer, constants_js_1.USDC_MINT, this.wallet.publicKey).then((account) => account.address);
            this.walletWSol = yield (0, spl_token_1.getOrCreateAssociatedTokenAccount)(this.connection, this.wallet.payer, constants_js_1.WSOL_MINT, this.wallet.publicKey).then((account) => account.address);
            // Initialize Drift
            this.driftClient = new sdk_1.DriftClient({
                connection: this.connection,
                wallet: this.wallet,
                env: 'mainnet-beta',
            });
            yield this.driftClient.subscribe();
            // Initialize Marginfi
            const flashLoanToken = "SOL";
            const marginfiClient = yield marginfi_client_v2_1.MarginfiClient.fetch((0, marginfi_client_v2_1.getConfig)(), this.wallet, this.connection);
            const wSolBank = (_a = marginfiClient.getBankByTokenSymbol(flashLoanToken)) === null || _a === void 0 ? void 0 : _a.address;
            if (!wSolBank)
                throw Error(`${flashLoanToken} bank not found`);
            this.wSolBank = wSolBank;
            const marginfiAccounts = yield marginfiClient.getMarginfiAccountsForAuthority(this.wallet.publicKey);
            if (marginfiAccounts.length === 0) {
                this.marginfiAccount = yield marginfiClient.createMarginfiAccount();
            }
            else {
                this.marginfiAccount = marginfiAccounts[0];
            }
            // Initialize Pyth
            this.pythSolanaReceiver = new pyth_solana_receiver_1.PythSolanaReceiver({ connection: this.connection, wallet: this.wallet });
            this.solUsdPriceFeedAccount = this.pythSolanaReceiver
                .getPriceFeedAccountAddress(0, "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");
            this.usdcUsdPriceFeedAccount = this.pythSolanaReceiver
                .getPriceFeedAccountAddress(0, "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a");
            this.isInitialized = true;
            console.log(`Auto-Repay Bot initialized with address ${this.wallet.publicKey}`);
        });
    }
    run() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.initialize();
            while (true) {
                const vaults = yield this.getAllVaults();
                for (const vault of vaults) {
                    const vaultAddress = vault.publicKey;
                    const owner = vault.account.owner;
                    try {
                        const driftUser = new driftUser_js_1.DriftUser(vaultAddress, this.connection, this.driftClient);
                        yield driftUser.initialize();
                        const driftHealth = driftUser.getHealth();
                        const quartzHealth = this.getQuartzHealth(driftHealth);
                        if (quartzHealth == 0) {
                            this.attemptAutoRepay(vaultAddress, owner, driftUser);
                        }
                        ;
                    }
                    catch (error) {
                        console.error(`Error finding Drift User for ${vault.account.owner}: ${error}`);
                    }
                }
            }
        });
    }
    getAllVaults() {
        return __awaiter(this, void 0, void 0, function* () {
            const vaults = yield this.program.account.vault.all();
            return vaults;
        });
    }
    getQuartzHealth(driftHealth) {
        if (driftHealth <= 0)
            return 0;
        if (driftHealth >= 100)
            return 100;
        return Math.floor(Math.min(100, Math.max(0, (driftHealth - constants_js_1.QUARTZ_HEALTH_BUFFER_PERCENTAGE) / (1 - (constants_js_1.QUARTZ_HEALTH_BUFFER_PERCENTAGE / 100)))));
    }
    attemptAutoRepay(vaultAddress, owner, driftUser) {
        return __awaiter(this, void 0, void 0, function* () {
            for (let retry = 0; retry < this.maxRetries; retry++) {
                try {
                    const usdcBalance = driftUser.getTokenAmount(constants_js_1.DRIFT_MARKET_INDEX_USDC);
                    if (usdcBalance.gte(sdk_1.ZERO)) {
                        console.error("Attempted to execute auto-repay on low health account but found no outstanding loans");
                        return;
                    }
                    const loanAmount = Math.abs(usdcBalance.toNumber());
                    const signature = yield this.executeAutoRepay(vaultAddress, owner, loanAmount);
                    const latestBlockhash = yield this.connection.getLatestBlockhash();
                    yield this.connection.confirmTransaction(Object.assign({ signature }, latestBlockhash), "confirmed");
                    console.log(`Executed auto-repay for ${owner}, signature: ${signature}`);
                    return;
                }
                catch (error) {
                    console.log(`Auto-repay transaction failed for ${owner}, retrying... Error: ${error}`);
                    continue;
                }
            }
            console.error(`Failed to execute auto-repay for ${owner}`);
        });
    }
    executeAutoRepay(vault, owner, loanAmountBaseUnits) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.isInitialized)
                throw new Error("AutoRepayBot is not initialized");
            const vaultWsol = (0, helpers_js_1.getVaultSpl)(vault, constants_js_1.WSOL_MINT);
            const vaultUsdc = (0, helpers_js_1.getVaultSpl)(vault, constants_js_1.USDC_MINT);
            const driftUser = (0, helpers_js_1.getDriftUser)(vault);
            const driftUserStats = (0, helpers_js_1.getDriftUserStats)(vault);
            const jupiterQuotePromise = (0, jupiter_js_1.getJupiterSwapQuote)(constants_js_1.WSOL_MINT, constants_js_1.USDC_MINT, loanAmountBaseUnits);
            const preLoanBalancePromise = this.connection.getTokenAccountBalance(this.walletWSol).then(res => res.value.amount);
            const autoRepayDepositPromise = this.program.methods
                .autoRepayDeposit(constants_js_1.DRIFT_MARKET_INDEX_USDC)
                .accounts({
                vault: vault,
                vaultSpl: vaultUsdc,
                owner: owner,
                caller: this.wallet.publicKey,
                callerSpl: this.walletUsdc,
                splMint: constants_js_1.USDC_MINT,
                driftUser: driftUser,
                driftUserStats: driftUserStats,
                driftState: this.driftState,
                spotMarketVault: this.driftSpotMarketUsdc,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
                driftProgram: constants_js_1.DRIFT_PROGRAM_ID,
                systemProgram: web3_js_1.SystemProgram.programId,
                instructions: web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY,
            })
                .remainingAccounts([
                (0, helpers_js_1.toRemainingAccount)(constants_js_1.DRIFT_ORACLE_2, false, false),
                (0, helpers_js_1.toRemainingAccount)(constants_js_1.DRIFT_ORACLE_1, false, false),
                (0, helpers_js_1.toRemainingAccount)(constants_js_1.DRIFT_SPOT_MARKET_SOL, true, false),
                (0, helpers_js_1.toRemainingAccount)(constants_js_1.DRIFT_SPOT_MARKET_USDC, true, false)
            ])
                .instruction();
            const autoRepayWithdrawPromise = this.program.methods
                .autoRepayWithdraw(constants_js_1.DRIFT_MARKET_INDEX_SOL)
                .accounts({
                vault: vault,
                vaultSpl: vaultWsol,
                owner: owner,
                caller: this.wallet.publicKey,
                callerSpl: this.walletWSol,
                splMint: constants_js_1.WSOL_MINT,
                driftUser: driftUser,
                driftUserStats: driftUserStats,
                driftState: this.driftState,
                spotMarketVault: this.driftSpotMarketSol,
                driftSigner: constants_js_1.DRIFT_SIGNER,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                driftProgram: constants_js_1.DRIFT_PROGRAM_ID,
                systemProgram: web3_js_1.SystemProgram.programId,
                depositPriceUpdate: this.usdcUsdPriceFeedAccount,
                withdrawPriceUpdate: this.solUsdPriceFeedAccount,
                instructions: web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY,
            })
                .remainingAccounts([
                (0, helpers_js_1.toRemainingAccount)(constants_js_1.DRIFT_ORACLE_2, false, false),
                (0, helpers_js_1.toRemainingAccount)(constants_js_1.DRIFT_ORACLE_1, false, false),
                (0, helpers_js_1.toRemainingAccount)(constants_js_1.DRIFT_SPOT_MARKET_SOL, true, false),
                (0, helpers_js_1.toRemainingAccount)(constants_js_1.DRIFT_SPOT_MARKET_USDC, false, false)
            ])
                .instruction();
            const [preLoanBalance, jupiterQuote] = yield Promise.all([preLoanBalancePromise, jupiterQuotePromise]);
            const jupiterSwapPromise = (0, jupiter_js_1.getJupiterSwapIx)(this.wallet.publicKey, this.connection, jupiterQuote);
            const amountLamports = Number(jupiterQuote.inAmount);
            const amountLamportsWithSlippage = Math.floor(amountLamports * (1.01));
            const walletWsolBalance = Number(preLoanBalance) + amountLamportsWithSlippage;
            const autoRepayStartPromise = this.program.methods
                .autoRepayStart(new anchor_1.BN(walletWsolBalance))
                .accounts({
                caller: this.wallet.publicKey,
                callerWithdrawSpl: this.walletWSol,
                withdrawMint: constants_js_1.WSOL_MINT,
                vault: vault,
                vaultWithdrawSpl: vaultWsol,
                owner: owner,
                tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
                associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: web3_js_1.SystemProgram.programId,
                instructions: web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY,
            })
                .instruction();
            const [ix_autoRepayStart, jupiterSwap, ix_autoRepayDeposit, ix_autoRepayWithdraw] = yield Promise.all([autoRepayStartPromise, jupiterSwapPromise, autoRepayDepositPromise, autoRepayWithdrawPromise]);
            const { ix_jupiterSwap, jupiterLookupTables } = jupiterSwap;
            const amountSolUi = new bignumber_js_1.default(amountLamportsWithSlippage).div(web3_js_1.LAMPORTS_PER_SOL);
            const { flashloanTx } = yield this.marginfiAccount.makeLoopTx(amountSolUi, amountSolUi, this.wSolBank, this.wSolBank, [ix_autoRepayStart, ix_jupiterSwap, ix_autoRepayDeposit, ix_autoRepayWithdraw], [this.quartzLookupTable, ...jupiterLookupTables], 0.002, false);
            const signedTx = yield this.wallet.signTransaction(flashloanTx);
            const signature = yield this.connection.sendRawTransaction(signedTx.serialize());
            return signature;
        });
    }
}
exports.AutoRepayBot = AutoRepayBot;
