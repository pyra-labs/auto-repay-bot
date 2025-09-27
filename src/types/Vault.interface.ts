export interface VaultResponse {
	address: string;
	vault: VaultData;
	depositAddress: {
		lamports: number;
		splAccounts: DepositAddressSplAccount[];
	};
}

export interface VaultData {
	owner: string;
	bump: number;
	spend_limit_per_transaction: number;
	spend_limit_per_timeframe: number;
	remaining_spend_limit_per_timeframe: number;
	next_timeframe_reset_timestamp: number;
	timeframe_in_seconds: number;
}

export interface DepositAddressSplAccount {
	mint: string;
	owner: string;
	amount: number;
	delegate: string | null;
	state: number;
	is_native: number | null;
	delegated_amount: number;
	close_authority: string | null;
}
