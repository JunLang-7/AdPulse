import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
		const path = resolve(dir, entry.name);
		return entry.isDirectory()
			? files(path)
			: path.endsWith(".ts")
				? [path]
				: [];
	});
}
test("source dependencies respect core/infrastructure/composition boundaries", () => {
	const modules: Record<string, string[]> = {
		"packages/core": [],
		"packages/channels": ["@adpluse/core"],
		"packages/storage": ["@adpluse/core"],
		"packages/runtime": [
			"@adpluse/core",
			"@adpluse/channels",
			"@adpluse/storage",
		],
		"apps/api": ["@adpluse/core", "@adpluse/channels", "@adpluse/runtime"],
		"apps/worker": ["@adpluse/runtime"],
		"apps/console": [],
	};
	for (const [module, allowed] of Object.entries(modules)) {
		const root = resolve(module, "src");
		for (const path of files(root)) {
			const source = ts.createSourceFile(
				path,
				readFileSync(path, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			const check = (specifier: string) => {
				const label = `${relative(process.cwd(), path)} -> ${specifier}`;
				if (specifier.startsWith(".")) {
					assert.ok(
						!relative(root, resolve(dirname(path), specifier)).startsWith(".."),
						label,
					);
				} else if (specifier.startsWith("@adpluse/")) {
					assert.ok(allowed.includes(specifier), label);
				}
				if (module === "packages/core") {
					assert.ok(
						specifier.startsWith(".") || specifier === "node:crypto",
						label,
					);
				}
			};
			const visit = (node: ts.Node) => {
				if (
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier &&
					ts.isStringLiteral(node.moduleSpecifier)
				)
					check(node.moduleSpecifier.text);
				if (
					ts.isCallExpression(node) &&
					node.expression.kind === ts.SyntaxKind.ImportKeyword
				) {
					const specifier = node.arguments[0];
					if (!specifier || !ts.isStringLiteral(specifier))
						assert.fail("dynamic import must be statically inspectable");
					check(specifier.text);
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
	}
});
