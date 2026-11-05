import { lazy } from "react";
import { Navigate } from "react-router";
import Loadable from "../layouts/full/shared/loadable/Loadable";

const FullLayout = Loadable(lazy(() => import("../layouts/full/FullLayout")));
const AdpulseSessions = Loadable(lazy(() => import("../views/adpulse/sessions")));

const Router = [
  {
    path: "/",
    element: <FullLayout />,
    children: [
      { path: "/", element: <AdpulseSessions /> },
      { path: "/adpulse/sessions", element: <AdpulseSessions /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];

export default Router;
