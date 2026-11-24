import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Guest } from './Guest';
import './styles.css';

const AdminPage = lazy(async () => ({ default: (await import('./Admin')).Admin }));
const isAdmin = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');

createRoot(document.getElementById('root')!).render(isAdmin ? (
  <Suspense fallback={<p className="site-loading" role="status">Đang mở quản trị…</p>}><AdminPage /></Suspense>
) : <Guest />);
