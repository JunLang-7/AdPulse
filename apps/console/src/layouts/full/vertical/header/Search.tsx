import { Component, Search as SearchIcon } from "lucide-react";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import SimpleBar from "simplebar-react";

import { Input } from "@/components/ui/input";
import SidebarContent from "../../vertical/sidebar/sidebaritems";

type MenuNode = {
	name?: string;
	url?: string;
	icon?: ComponentType<{ width?: number; height?: number }>;
	items?: MenuNode[];
};

type SearchResult = {
	name: string;
	url: string;
	path: string;
	icon?: MenuNode["icon"];
};

const searchItems = (
	items: MenuNode[],
	q: string,
	parentPath = "",
): SearchResult[] => {
	const needle = q.toLowerCase();
	let results: SearchResult[] = [];

	for (const item of items) {
		const label = item.name ?? "";
		const currentPath = parentPath ? `${parentPath} → ${label}` : label;

		if (item.name && item.url && item.name.toLowerCase().includes(needle)) {
			results.push({
				name: item.name,
				url: item.url,
				path: currentPath,
				icon: item.icon,
			});
		}

		if (item.items) {
			results = [...results, ...searchItems(item.items, q, currentPath)];
		}
	}

	return results;
};

const menu = SidebarContent as MenuNode[];

function Search() {
	const [query, setQuery] = useState("");

	const results = useMemo(() => {
		if (!query.trim()) return [];
		return searchItems(menu, query);
	}, [query]);

	return (
		<div className="relative w-full">
			<div className="flex items-center relative w-xs mx-auto ">
				<SearchIcon
					size={16}
					className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					placeholder="搜索会话…"
					className="rounded-lg pl-10!"
					required
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
			</div>
			<div
				className={`absolute w-full bg-card rounded-md top-11 z-10 start-0 shadow-md border border-border ${
					query ? "block" : "hidden"
				}`}
			>
				<SimpleBar className="h-72 p-4 custom-scroll">
					{results.length ? (
						results.map((item) => (
							<Link
								key={item.url}
								to={item.url}
								onClick={() => setQuery("")}
								className="p-2 mb-1.5 last:mb-0 flex items-center bg-input/30 gap-2 text-sm font-medium rounded-md hover:bg-primary/5 hover:text-primary w-full overflow-hidden"
							>
								<div className="flex items-center">
									<Component width={18} height={18} />
									<div className="ps-3">
										<h5 className="mb-1 text-sm group-hover/link:text-primary">
											{item.name}
										</h5>
										<span className="text-xs block truncate max-w-60">
											{item.path}
										</span>
									</div>
								</div>
							</Link>
						))
					) : (
						<div className="flex items-center justify-center h-full">
							<h1 className="text-medium font-medium">没有匹配结果</h1>
						</div>
					)}
				</SimpleBar>
			</div>
		</div>
	);
}

export default Search;
