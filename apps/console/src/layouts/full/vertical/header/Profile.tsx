import { Icon } from "@iconify/react";
import { Mailbox } from "lucide-react";
import { Link } from "react-router";
import { Avatar, AvatarFallback, AvatarImage } from "src/components/ui/avatar";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetFooter,
	SheetTrigger,
} from "src/components/ui/sheet";
import { cn } from "src/lib/utils";
import { profileDD } from "./data";
export default function ProfileSheet() {
	return (
		<Sheet>
			{/* Trigger Button */}
			<SheetTrigger className="cursor-pointer hover:bg-primary/5 flex items-center justify-center rounded-full h-10 w-10">
				<Avatar className="h-8 w-8">
					<AvatarImage src="" alt="profile" />
					<AvatarFallback>CM</AvatarFallback>
				</Avatar>
			</SheetTrigger>

			{/* Drawer Panel */}
			<SheetContent
				showCloseButton={false}
				side="right"
				className="border-s-0 w-full sm:max-w-80 max-w-60"
			>
				<SheetClose className="absolute top-5 end-5 p-2 hover:bg-primary/5 hover:text-primary rounded-full">
					<Icon icon="tabler:x" width={20} height={20} />
				</SheetClose>
				{/* Top Profile Section */}
				<div className="p-6 py-6">
					<div className="flex flex-col gap-4 justify-center items-center pt-10">
						<Avatar className="h-16 w-16">
							<AvatarImage src="" alt="Profile" width={30} height={30} />
							<AvatarFallback>AD</AvatarFallback>
						</Avatar>

						<div className="text-center">
							<h6 className="text-lg font-semibold">AdPulse 操作员</h6>
							<div className="flex items-center gap-2 justify-center">
								<Mailbox size={18} className="text-muted-foreground" />
								<span className="text-sm font-normal text-muted-foreground">
									本地开发账号
								</span>
							</div>
						</div>
					</div>
				</div>

				{/* Menu List */}
				<div className="border-t  border-border">
					<ul className="flex flex-col gap-2 p-6">
						{profileDD.map((item) => (
							<li key={item.title} className="group">
								<Link
									to={item.href}
									className={cn(
										"flex gap-3 py-2 px-3 rounded-md group-hover:bg-primary/5 text-muted-foreground",
									)}
								>
									<item.avatar
										width={20}
										height={20}
										className="group-hover:text-primary"
									/>

									<div className="flex gap-3 items-center">
										<h6 className="text-sm group-hover:text-primary">
											{item.title}
										</h6>

										{item.badge && (
											<span className="h-5 w-6 text-sm flex justify-center items-center text-primary rounded-sm bg-primary/5">
												4
											</span>
										)}
									</div>
								</Link>
							</li>
						))}
					</ul>
				</div>

				{/* Footer */}
				<SheetFooter className="px-0 pb-6">
					<div className="rounded-sm pt-6 text-center text-sm text-muted-foreground">
						AdPulse 控制台 · 开发版本
					</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
