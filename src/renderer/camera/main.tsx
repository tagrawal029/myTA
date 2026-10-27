import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import '../settings/settings.css';
import { Problem } from './Problem';

createRoot(document.getElementById('app')!).render(<Problem />);
