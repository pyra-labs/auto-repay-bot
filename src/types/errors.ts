export class CollateralBelowMinimumError extends Error {
    constructor(message = "Collateral is below minimum amount") {
        super(message);
        this.name = "CollateralBelowMinimumError";
    }
} 