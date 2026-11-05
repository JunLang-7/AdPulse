import { RouterProvider, createBrowserRouter } from 'react-router';
import routerConfig from './routes/Router';
const router = createBrowserRouter(routerConfig);
import './css/globals.css';

function App() {
  return (
    <>
    
      <RouterProvider router={router} />
    </>
  );
}

export default App;
