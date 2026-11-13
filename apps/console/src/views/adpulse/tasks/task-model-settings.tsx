import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import {
	ModelConfigDialog,
	modelCatalogKey,
	modelConnectionsKey,
	selectionLabel,
	type ModelCatalog,
	type ModelConnectionList,
	type TaskModelChoice,
} from "../models/model-config-dialog";

/**
 * 任务内的轻量入口：只显示当前选择并打开统一配置窗口，
 * 不维护第二份供应商/密钥配置。
 */
export function TaskModelSettings({ selected, onSelect, disabled }: {
	selected: TaskModelChoice | undefined;
	onSelect: (choice: TaskModelChoice) => void;
	disabled: boolean;
}) {
	const [open, setOpen] = useState(false);
	const queryClient = useQueryClient();
	const label = selectionLabel(
		selected,
		queryClient.getQueryData<ModelConnectionList | null>(modelConnectionsKey) ?? undefined,
		queryClient.getQueryData<ModelCatalog>(modelCatalogKey),
	);

	return (
		<>
			<Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
				{label}
			</Button>
			<ModelConfigDialog
				open={open}
				onOpenChange={setOpen}
				choice={selected}
				onUse={(choice) => {
					onSelect(choice);
					setOpen(false);
				}}
			/>
		</>
	);
}
