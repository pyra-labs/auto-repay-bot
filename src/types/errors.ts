export class CollateralBelowMinimumError extends Error {
	public collateralValue: number;

	constructor(collateralValue: number) {
		super(
			`Collateral is below minimum amount, total value: ${collateralValue}`,
		);
		this.name = "CollateralBelowMinimumError";
		this.collateralValue = collateralValue;
	}
}
