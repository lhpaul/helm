import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Kanban } from './views/Kanban.js';
import { ItemDetail } from './views/ItemDetail.js';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Kanban />} />
        <Route path="/items/:id" element={<ItemDetail />} />
      </Routes>
    </BrowserRouter>
  );
}
