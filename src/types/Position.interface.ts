import type { MarketIndex } from "@quartz-labs/sdk";

export interface Position {
    marketIndex: MarketIndex;
    value: number;
}