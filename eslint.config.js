import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["dist/", "node_modules/", "traces/", "eslint.config.js"] },
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			"@typescript-eslint/consistent-type-imports": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",
			"@typescript-eslint/no-non-null-assertion": "error",
			"no-console": "off",
		},
	},
	{
		files: ["test/**/*.ts"],
		rules: {
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
		},
	},
);
