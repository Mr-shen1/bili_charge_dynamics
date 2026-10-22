import { Route, Routes } from 'react-router';
import type { DynamicReader } from '../data/contracts';
import { ListPage } from '../dynamics/ListPage';
import { DetailPage } from '../dynamics/DetailPage';
import { CommentThreadPage } from '../dynamics/CommentThreadPage';
import { SessionProvider } from './Navigation';
import { NotFoundPage } from './NotFoundPage';
import { ManagePage } from '../manage/ManagePage';
import type { ManagementApi } from '../manage/managementApi';

export function App({ reader, manageApi }: { reader: DynamicReader; manageApi?: ManagementApi }) {
  return <SessionProvider><Routes>
    <Route path="/" element={<ListPage reader={reader} />} />
    <Route path="/ups/:upId" element={<ListPage reader={reader} />} />
    <Route path="/dynamics/:dynamicId" element={<DetailPage reader={reader} />} />
    <Route path="/dynamics/:dynamicId/comments/:rootId" element={<CommentThreadPage reader={reader} />} />
    <Route path="/manage" element={<ManagePage api={manageApi} />} />
    <Route path="*" element={<NotFoundPage />} />
  </Routes></SessionProvider>;
}
