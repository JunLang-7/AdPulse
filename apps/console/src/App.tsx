import { createBrowserRouter, RouterProvider } from "react-router";
import "./css/globals.css";
import routerConfig from "./routes/Router";

const router = createBrowserRouter(routerConfig);

export default function App() {
	return <RouterProvider router={router} />;
}
