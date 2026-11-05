import { Suspense, ComponentType, FC } from "react";

const Loadable =
  <P extends object>(Component: ComponentType<P>): FC<P> =>
  (props: P) =>
    (
      <Suspense fallback={<div className="p-6">加载中…</div>}>
        <Component {...props} />
      </Suspense>
    );

export default Loadable;
