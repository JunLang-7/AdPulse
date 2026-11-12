import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
	return (
		<DialogPrimitive.Backdrop
			data-slot="dialog-backdrop"
			className={cn(
				"fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
				className,
			)}
			{...props}
		/>
	);
}

function DialogContent({
	className,
	children,
	...props
}: DialogPrimitive.Popup.Props) {
	return (
		<DialogPrimitive.Portal>
			<DialogBackdrop />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				className={cn(
					"fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] w-[min(calc(100vw-2rem),46rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
					className,
				)}
				{...props}
			>
				{children}
			</DialogPrimitive.Popup>
		</DialogPrimitive.Portal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex items-start justify-between gap-4 border-b px-5 py-3.5", className)}
			{...props}
		/>
	);
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("text-base font-semibold", className)}
			{...props}
		/>
	);
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn("text-xs text-muted-foreground", className)}
			{...props}
		/>
	);
}

function DialogCloseButton({ className, ...props }: DialogPrimitive.Close.Props) {
	return (
		<DialogPrimitive.Close
			data-slot="dialog-close"
			aria-label="关闭"
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
				className,
			)}
			{...props}
		>
			<XIcon className="size-3.5" aria-hidden="true" />
			关闭
		</DialogPrimitive.Close>
	);
}

export {
	Dialog,
	DialogTrigger,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogCloseButton,
};
