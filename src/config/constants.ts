import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export const MIN_LAMPORTS_BALANCE = 0.001 * LAMPORTS_PER_SOL;
export const LOOP_DELAY = 30_000;
export const MAX_AUTO_REPAY_ATTEMPTS = 3;

export const GOAL_HEALTH = 60;
export const JUPITER_SLIPPAGE_BPS = 50;

export const DEFAULT_COMPUTE_UNIT_LIMIT = 700_000;