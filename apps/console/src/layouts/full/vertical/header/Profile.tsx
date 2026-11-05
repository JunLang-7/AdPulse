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

const isExternal = (href: string) => href.startsWith("http");

export default function ProfileSheet() {
	return (
		<Sheet>
			<SheetTrigger className="cursor-pointer hover:bg-primary/5 flex items-center justify-center rounded-full h-10 w-10">
				<Avatar className="h-8 w-8">
					<AvatarImage src="" alt="profile" />
					<AvatarFallback>AD</AvatarFallback>
				</Avatar>
			</SheetTrigger>

			<SheetContent
				showCloseButton={false}
				side="right"
				className="border-s-0 w-full sm:max-w-80 max-w-60"
			>
				<SheetClose className="absolute top-5 end-5 p-2 hover:bg-primary/5 hover:text-primary rounded-full">
					<Icon icon="tabler:x" width={20} height={20} />
				</SheetClose>

				<div className="flex flex-col gap-6 py-6">
					<div className="flex flex-col items-center gap-3">
						<Avatar className="h-16 w-16">
							<AvatarImage src="" alt="profile" />
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

					<div className="border-t border-border pt-4">
						<ul className="flex flex-col gap-1">
							{profileDD.map((item) => {
								const content = (
									<>
										<item.avatar
											width={20}
											height={20}
											className="group-hover:text-primary"
										/>
										<h6 className="text-sm group-hover:text-primary">
											{item.title}
										</h6>
									</>
								);
								const className = cn(
									"flex items-center gap-3 py-2 px-3 rounded-md group-hover:bg-primary/5 text-muted-foreground",
								);
								return (
									<li key={item.title} className="group">
										{isExternal(item.href) ? (
											<a
												href={item.href}
												target="_blank"
												rel="noreferrer"
												className={className}
											>
												{content}
											</a>
										) : (
											<Link to={item.href} className={className}>
												{content}
											</Link>
										)}
									</li>
								);
							})}
						</ul>
					</div>
				</div>

				<SheetFooter className="px-0 pb-6">
					<div className="rounded-sm pt-6 text-center text-sm text-muted-foreground">
						AdPulse 控制台 · 开发版本
					</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
