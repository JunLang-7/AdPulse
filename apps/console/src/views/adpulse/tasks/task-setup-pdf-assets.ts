/// <reference types="vite/client" />

// Use assets from the installed PDF.js version so CID fonts can be decoded
// locally, even when the PDF only names a predefined CMap.
const packagedCMaps = import.meta.glob<string>("../../../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
	eager: true,
	exhaustive: true,
	import: "default",
	query: "?url",
});
const byName = new Map(Object.entries(packagedCMaps).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]));

export class TaskPdfBinaryData {
	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const asset = kind === "cMapUrl" ? byName.get(filename) : undefined;
		if (!asset) throw new Error("PDF resource unavailable");
		const response = await fetch(asset, { redirect: "error" });
		if (!response.ok) throw new Error("PDF resource unavailable");
		return new Uint8Array(await response.arrayBuffer());
	}
}
