export type Quartz = {
  "version": "0.1.21",
  "name": "quartz",
  "instructions": [
    {
      "name": "initUser",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "closeUser",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        }
      ],
      "args": []
    },
    {
      "name": "initDriftAccount",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "rent",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "closeDriftAccount",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "deposit",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "ownerSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "splMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "spotMarketVault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "associatedTokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amountBaseUnits",
          "type": "u64"
        },
        {
          "name": "driftMarketIndex",
          "type": "u16"
        },
        {
          "name": "reduceOnly",
          "type": "bool"
        }
      ]
    },
    {
      "name": "withdraw",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "ownerSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "splMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "spotMarketVault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftSigner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "associatedTokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amountBaseUnits",
          "type": "u64"
        },
        {
          "name": "driftMarketIndex",
          "type": "u16"
        },
        {
          "name": "reduceOnly",
          "type": "bool"
        }
      ]
    },
    {
      "name": "autoRepayStart",
      "accounts": [
        {
          "name": "caller",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "callerWithdrawSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "withdrawMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultWithdrawSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "associatedTokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "startWithdrawBalance",
          "type": "u64"
        }
      ]
    },
    {
      "name": "autoRepayDeposit",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "caller",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "callerSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "splMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "spotMarketVault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "associatedTokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "driftMarketIndex",
          "type": "u16"
        }
      ]
    },
    {
      "name": "autoRepayWithdraw",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "caller",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "callerSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "splMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "spotMarketVault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftSigner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "depositPriceUpdate",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "withdrawPriceUpdate",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "driftMarketIndex",
          "type": "u16"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "vault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "publicKey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "IllegalAutoRepayInstructions",
      "msg": "Illegal auto repay instructions"
    },
    {
      "code": 6001,
      "name": "InvalidRepayMint",
      "msg": "Invalid mint provided"
    },
    {
      "code": 6002,
      "name": "MaxSlippageExceeded",
      "msg": "Price slippage is above maximum"
    },
    {
      "code": 6003,
      "name": "InvalidPlatformFee",
      "msg": "Swap platform fee must be zero"
    },
    {
      "code": 6004,
      "name": "InvalidUserAccounts",
      "msg": "User accounts for deposit and withdraw do not match"
    },
    {
      "code": 6005,
      "name": "InvalidSourceTokenAccount",
      "msg": "Swap source token account does not match withdraw"
    },
    {
      "code": 6006,
      "name": "InvalidDestinationTokenAccount",
      "msg": "Swap destination token account does not match deposit"
    },
    {
      "code": 6007,
      "name": "InvalidStartBalance",
      "msg": "Declared start balance is not accurate"
    },
    {
      "code": 6008,
      "name": "NegativeOraclePrice",
      "msg": "Price received from oracle should be a positive number"
    },
    {
      "code": 6009,
      "name": "UnsupportedDriftMarketIndex",
      "msg": "Unsupported Drift market index"
    },
    {
      "code": 6010,
      "name": "MathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6011,
      "name": "InvalidPriceExponent",
      "msg": "Price exponents received from oracle should be the same"
    },
    {
      "code": 6012,
      "name": "UnableToLoadAccountLoader",
      "msg": "Unable to load account loader"
    },
    {
      "code": 6013,
      "name": "DeserializationError",
      "msg": "Could not deserialize introspection instruction data"
    },
    {
      "code": 6014,
      "name": "NotReachedAutoRepayThreshold",
      "msg": "Account health is not low enough for auto_repay"
    },
    {
      "code": 6015,
      "name": "AutoRepayHealthTooLow",
      "msg": "Not enough collateral sold in auto_repay"
    },
    {
      "code": 6016,
      "name": "AutoRepayHealthTooHigh",
      "msg": "Too much collateral sold in auto_repay"
    }
  ]
};

export const IDL: Quartz = {
  "version": "0.1.21",
  "name": "quartz",
  "instructions": [
    {
      "name": "initUser",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "closeUser",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        }
      ],
      "args": []
    },
    {
      "name": "initDriftAccount",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "rent",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "closeDriftAccount",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "deposit",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "ownerSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "splMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "spotMarketVault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "associatedTokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amountBaseUnits",
          "type": "u64"
        },
        {
          "name": "driftMarketIndex",
          "type": "u16"
        },
        {
          "name": "reduceOnly",
          "type": "bool"
        }
      ]
    },
    {
      "name": "withdraw",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "ownerSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "splMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "spotMarketVault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftSigner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "associatedTokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amountBaseUnits",
          "type": "u64"
        },
        {
          "name": "driftMarketIndex",
          "type": "u16"
        },
        {
          "name": "reduceOnly",
          "type": "bool"
        }
      ]
    },
    {
      "name": "autoRepayStart",
      "accounts": [
        {
          "name": "caller",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "callerWithdrawSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "withdrawMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultWithdrawSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "associatedTokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "startWithdrawBalance",
          "type": "u64"
        }
      ]
    },
    {
      "name": "autoRepayDeposit",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "caller",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "callerSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "splMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "spotMarketVault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "associatedTokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "driftMarketIndex",
          "type": "u16"
        }
      ]
    },
    {
      "name": "autoRepayWithdraw",
      "accounts": [
        {
          "name": "vault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "vaultSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "caller",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "callerSpl",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "splMint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftUser",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftUserStats",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftState",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "spotMarketVault",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "driftSigner",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "driftProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "depositPriceUpdate",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "withdrawPriceUpdate",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "driftMarketIndex",
          "type": "u16"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "vault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "publicKey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "IllegalAutoRepayInstructions",
      "msg": "Illegal auto repay instructions"
    },
    {
      "code": 6001,
      "name": "InvalidRepayMint",
      "msg": "Invalid mint provided"
    },
    {
      "code": 6002,
      "name": "MaxSlippageExceeded",
      "msg": "Price slippage is above maximum"
    },
    {
      "code": 6003,
      "name": "InvalidPlatformFee",
      "msg": "Swap platform fee must be zero"
    },
    {
      "code": 6004,
      "name": "InvalidUserAccounts",
      "msg": "User accounts for deposit and withdraw do not match"
    },
    {
      "code": 6005,
      "name": "InvalidSourceTokenAccount",
      "msg": "Swap source token account does not match withdraw"
    },
    {
      "code": 6006,
      "name": "InvalidDestinationTokenAccount",
      "msg": "Swap destination token account does not match deposit"
    },
    {
      "code": 6007,
      "name": "InvalidStartBalance",
      "msg": "Declared start balance is not accurate"
    },
    {
      "code": 6008,
      "name": "NegativeOraclePrice",
      "msg": "Price received from oracle should be a positive number"
    },
    {
      "code": 6009,
      "name": "UnsupportedDriftMarketIndex",
      "msg": "Unsupported Drift market index"
    },
    {
      "code": 6010,
      "name": "MathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6011,
      "name": "InvalidPriceExponent",
      "msg": "Price exponents received from oracle should be the same"
    },
    {
      "code": 6012,
      "name": "UnableToLoadAccountLoader",
      "msg": "Unable to load account loader"
    },
    {
      "code": 6013,
      "name": "DeserializationError",
      "msg": "Could not deserialize introspection instruction data"
    },
    {
      "code": 6014,
      "name": "NotReachedAutoRepayThreshold",
      "msg": "Account health is not low enough for auto_repay"
    },
    {
      "code": 6015,
      "name": "AutoRepayHealthTooLow",
      "msg": "Not enough collateral sold in auto_repay"
    },
    {
      "code": 6016,
      "name": "AutoRepayHealthTooHigh",
      "msg": "Too much collateral sold in auto_repay"
    }
  ]
};
