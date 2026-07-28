function log( message: string ): void {
	console.log( message );
}

export function run(): void {
	const messageA: string = "a repeated long literal that makes TerserCompanion alias this string profitably and saves bytes";
	const messageB: string = "a repeated long literal that makes TerserCompanion alias this string profitably and saves bytes";
	const messageC: string = "a repeated long literal that makes TerserCompanion alias this string profitably and saves bytes";
	const messageD: string = "a repeated long literal that makes TerserCompanion alias this string profitably and saves bytes";
	const messageE: string = "a repeated long literal that makes TerserCompanion alias this string profitably and saves bytes";

	log( messageA );
	log( messageB + messageC + messageD + messageE );
}
