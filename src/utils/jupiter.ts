import { AddressLookupTableAccount, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { QuoteResponse } from '@jup-ag/api';

export async function getJupiterSwapQuote(
    inputMint: PublicKey, 
    outputMint: PublicKey, 
    amount: number,
    slippageBps: number
) {
    const quoteEndpoint = 
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=${slippageBps}&swapMode=ExactOut&onlyDirectRoutes=true`;
    const quoteResponse: QuoteResponse = await (await fetch(quoteEndpoint)).json();
    return quoteResponse;
}

export async function getJupiterSwapIx(walletPubkey: PublicKey, connection: Connection, quoteResponse: QuoteResponse) {
    const instructions = await (
        await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: walletPubkey.toBase58(),
                useCompression: true,
            })
        })
    ).json();

    if (instructions.error) {
        throw new Error("Failed to get swap instructions: " + instructions.error);
    }
    const { swapInstruction, addressLookupTableAddresses } = instructions;

    const getAddressLookupTableAccounts = async (
        keys: string[]
      ): Promise<AddressLookupTableAccount[]> => {
        const addressLookupTableAccountInfos =
          await connection.getMultipleAccountsInfo(
            keys.map((key) => new PublicKey(key))
          );
      
        return addressLookupTableAccountInfos.reduce((acc: any, accountInfo: any, index: any) => {
          const addressLookupTableAddress = keys[index];
          if (accountInfo) {
            const addressLookupTableAccount = new AddressLookupTableAccount({
              key: new PublicKey(addressLookupTableAddress),
              state: AddressLookupTableAccount.deserialize(accountInfo.data),
            });
            acc.push(addressLookupTableAccount);
          }
      
          return acc;
        }, new Array<AddressLookupTableAccount>());
    };

    const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
    addressLookupTableAccounts.push(
        ...(await getAddressLookupTableAccounts(addressLookupTableAddresses))
    );

    const ix_jupiterSwap =  new TransactionInstruction({
        programId: new PublicKey(swapInstruction.programId),
        keys: swapInstruction.accounts.map((key: any) => ({
        pubkey: new PublicKey(key.pubkey),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
        })),
        data: Buffer.from(swapInstruction.data, "base64"),
    });

    return {
        ix_jupiterSwap,
        jupiterLookupTables: addressLookupTableAccounts,
    };
}