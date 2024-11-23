<div align="center">
  <img width="2500" alt="Quartz" src="https://cdn.prod.website-files.com/65707af0f4af991289bbd432/670e37661cdb2314fe8ba469_logo-glow-banner.jpg" />

  <h1 style="margin-top:20px;">Quartz Auto-Repay Bot</h1>
</div>

Quartz loans are issued through integrated protocols, which have liquidation thresholds - the maximum loan amount you can take out against your deposited collateral. If the value of deposited collateral falls too low, it will be liquidated (incurring a 5% fee).

This bot monitors all Quartz accounts and calls the Auto-Repay instruction on any that are close to this liquidation threshold. Auto-Repay will swap the collateral to pay off the loan using a Jupiter swap with <1% slippage.

## Implementation

This bot is open-source and acts as a base implementation. It uses MarginFi flash loans to borrow the capital required to pay off the loan, then repays the flash loan with the Quartz account's collateral.

Feel free to fork this repository and make optimisations. The Quartz protocol will allow up to 1% slippage in the loan repay swap, so you can take any profits on the difference with the Jupiter swap.

## How Auto-Repay Transactions work

To carry out an Auto-Repay transaction, the following instructions must be called in order:

1. auto_repay_start (Quartz)
2. exact_out_route (Jupiter)
3. auto_repay_deposit (Quartz)
4. auto_repay_withdraw (Quartz)

This bot wraps these instructions around a MarginFi flash loan. See executeAutoRepay() in src/autoRepayBot.ts for exactly how it does this.

## Running your own bot

As is, this bot can be run on your own machine or by using AWS. To use AWS, you will need to use AWS's Secret Management Service for the private key and should have a .env file similar to this:

```
RPC_URL = https://api.mainnet-beta.solana.com 
USE_AWS = true
AWS_SECRET_NAME = autoRepayCredentials
AWS_REGION = eu-north-1
```

You can also run this bot on your own machine, in which case you will need to provide the secret key in a Uint8 byte array format, similar to:

```
RPC_URL = https://api.mainnet-beta.solana.com 
USE_AWS = false
SECRET_KEY = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
```

In either case, you can run the bot with `npm run start`. The bot's address will need enough SOL to create 2 ATAs and a MarginFi account when initializing for the first time, and enough for gas fees after that.