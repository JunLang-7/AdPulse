import { Link } from "react-router";

const FullLogo = () => {
	return (
		<Link to="/" className="flex items-center gap-2 overflow-hidden">
			<img
				src="/branding/icon-color.svg"
				alt=""
				aria-hidden="true"
				className="size-6 shrink-0"
			/>
			<span className="text-lg font-semibold tracking-tight group-data-[state=collapsed]:hidden">
				AdPulse
			</span>
		</Link>
	);
};

export default FullLogo;
