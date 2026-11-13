import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import {
	ModelConfigDialog,
	modelCatalogKey,
	selectionLabel,
	type ModelCatalog,
	type ModelSelection,
} from "../models/model-config-dialog";

/**
 * 任务内的轻量入口：只显示当前选择并打开统一配置窗口，
 * 不再维护第二份供应商/密钥配置。
 */
export function TaskModelSettings({ selected, onSelect, disabled }: {
	selected: ModelSelection | undefined;
	onSelect: (selection: ModelSelection) => void;
	disabled: boolean;
}) {
	const [open, setOpen] = useState(false);
	const catalog = useQueryClient().getQueryData<ModelCatalog>(modelCatalogKey);
	const label = selected ? selectionLabel(catalog, selected) : "选择模型";

	return (
		<>
			<Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
				{label}
			</Button>
			<ModelConfigDialog
				open={open}
				onOpenChange={setOpen}
				selection={selected}
				onUse={(choice) => {
					onSelect(choice);
					setOpen(false);
				}}
			/>
		</>
	);
}
