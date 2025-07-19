<div align="center">
  <img width="2500" alt="Pyra" src="https://pyra.fi/open-graph.jpg" />

  <h1 style="margin-top:20px;">Pyra Auto-Repay Bot</h1>
</div>

Pyra loans are issued through integrated protocols, which have liquidation thresholds - the maximum loan amount you can take out against your deposited collateral. If the value of deposited collateral falls too low, it will be liquidated (incurring up to 10% in fees).

This bot monitors all Pyra accounts and calls the Auto-Repay instruction on any that are close to this liquidation threshold. Auto-Repay will swap the collateral to pay off the loan using a Jupiter swap with 1% slippage.

## Implementation

This bot is open-source and acts as a base implementation. It uses MarginFi flash loans to borrow the capital required to pay off the loan, then repays the flash loan with the Quartz account's collateral.

Feel free to fork this repository and make optimisations. The Pyra protocol will allow up to 1% slippage in the loan repay swap, so you can take any profits on the difference with the Jupiter swap.

## How Auto-Repay Transactions work

To carry out an Auto-Repay transaction, the following instructions must be called in order:

1. start_collateral_repay (Pyra)
2. Any swap transaction (eg: Jupiter)
3. deposit_collateral_repay (Pyra)
4. withdraw_collateral_repay (Pyra)

This bot wraps these instructions around a MarginFi flash loan. See executeAutoRepay() in src/collateralRepayBot.ts for exactly how it does this.

## Running your own bot

As is, this bot can be run on your own machine or by using AWS. To use AWS, you will need to use AWS's Secret Management Service for the private key and should have a .env file similar to this:

```
LIQUIDATOR_KEYPAIR=4KFBRq9...5Z7BWFz
RPC_URLS=https://api.mainnet-beta.solana.com 
USE_AWS=true
AWS_SECRET_NAME=secret
AWS_REGION=eu-north-1
EMAIL_TO=iarla@pyra.fi,diego@pyra.fi
EMAIL_FROM=diego@pyra.fi
EMAIL_HOST=your-email-client.com
EMAIL_PORT=123
EMAIL_USER=000000000@your-client-username.com
EMAIL_PASSWORD=0000000000
```

You can also run this bot on your own machine, in which case you will need to provide the secret key in base58 format, similar to:

```
LIQUIDATOR_KEYPAIR=4KFBRq9...5Z7BWFz
RPC_URLS=https://api.mainnet-beta.solana.com 
USE_AWS=false
AWS_SECRET_NAME=
AWS_REGION=
EMAIL_TO=iarla@pyra.fi,diego@pyra.fi
EMAIL_FROM=diego@pyra.fi
EMAIL_HOST=your-email-client.com
EMAIL_PORT=123
EMAIL_USER=000000000@your-client-username.com
EMAIL_PASSWORD=0000000000
```

The EMAIL_* variables are for error notifications through SMTP. In either case, you can run the bot with `npm run start`. The bot's address will need enough SOL to create 2 ATAs and a MarginFi account when initializing for the first time, and enough for gas fees after that. The bot uses yarn so no need for npm install, direct npm run start will build.

The initialistion of the ATA accounts should go through with a funded wallet, however you might experience errors such as:

--------------------------------
[2025-07-19 22:24:29] error: unhandledRejection: API bundle failed: Network congested. Endpoint is globally rate limited.
Error: API bundle failed: Network congested. Endpoint is globally rate limited.

The above error is from the jito bundle endpoint and just requires a bit patience or rerunning the bot at certain points when jito bundles arent limited. 

Subsequently you might encounter:
------ Transaction Details 👇 ------
📝 Executing 1 transaction
📡 Broadcast type: BUNDLE
💸 Bundle tip: undefined SOL
--------------------------------
[2025-07-19 22:43:54] error: unhandledRejection: API bundle failed: Bundle must tip at least 1000 lamports
Error: API bundle failed: Bundle must tip at least 1000 lamports

which is expected due to bundle tips being undefined. This will be resolved, but you should be able to check your accounts/ATA have been intiialised.