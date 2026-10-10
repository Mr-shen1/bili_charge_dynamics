import { Route, Routes } from 'react-router';
import type { DynamicReader } from '../data/contracts';
import { ListPage } from '../dynamics/ListPage';
import { DetailPage } from '../dynamics/DetailPage';
import { SessionProvider } from './Navigation';
import { NotFoundPage } from './NotFoundPage';

export function App({ reader }: { reader: DynamicReader }) {
  return <SessionProvider><Routes>
    <Route path="/" element={<ListPage reader={reader} />} />
    <Route path="/dynamics/:dynamicId" element={<DetailPage reader={reader} />} />
    <Route path="*" element={<NotFoundPage />} />
  </Routes></SessionProvider>;
}
