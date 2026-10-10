import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type DependencyMap = Record<string, string>;
type BundledDependencies = string[] | boolean;
interface PackageManifest {
	dependencies?: DependencyMap;
	optionalDependencies?: DependencyMap;
	devDependencies?: DependencyMap;
	peerDependencies?: DependencyMap;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	bundledDependencies?: BundledDependencies;
	bundleDependencies?: BundledDependencies;
}

const manifest: PackageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lockfile: { packages: Record<string, PackageManifest> } = JSON.parse(
	readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const hostPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];
const dependencySections = [
	"dependencies",
	"optionalDependencies",
	"devDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"bundledDependencies",
	"bundleDependencies",
] as const;

function bundledPackages(bundle: BundledDependencies | undefined): string[] {
	if (bundle === true) {
		return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
	}
	return Array.isArray(bundle) ? bundle : [];
}

describe("package manifest host dependencies", () => {
	it.each(hostPackages)("#given host package %s #when declaring peers #then its range is *", (hostPackage) => {
		expect(manifest.peerDependencies?.[hostPackage]).toBe("*");
	});

	it.each(hostPackages)("#given host package %s #when npm resolves peers #then it is optional", (hostPackage) => {
		expect(manifest.peerDependenciesMeta?.[hostPackage]?.optional).toBe(true);
	});

	it.each(hostPackages)(
		"#given host package %s #when installing production dependencies #then it is absent from runtime sections and bundles",
		(hostPackage) => {
			expect(manifest.dependencies ?? {}).not.toHaveProperty(hostPackage);
			expect(manifest.optionalDependencies ?? {}).not.toHaveProperty(hostPackage);
			expect(bundledPackages(manifest.bundledDependencies)).not.toContain(hostPackage);
			expect(bundledPackages(manifest.bundleDependencies)).not.toContain(hostPackage);
		},
	);

	it.each(hostPackages)(
		"#given host package %s #when developing standalone #then it is a development dependency",
		(hostPackage) => {
			expect(manifest.devDependencies?.[hostPackage]).toEqual(expect.any(String));
			expect(manifest.devDependencies?.[hostPackage]).not.toBe("");
		},
	);
});

describe("package-lock root dependency declarations", () => {
	it("#given the npm lockfile #when reading root metadata #then the package entry exists", () => {
		expect(lockfile.packages[""]).toBeDefined();
	});

	it.each(dependencySections)(
		"#given the real manifest #when comparing lockfile root %s #then the declarations match",
		(section) => {
			expect(lockfile.packages[""]?.[section]).toEqual(manifest[section]);
		},
	);
});
