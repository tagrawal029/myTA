import { createRoot } from 'react-dom/client';
import './setup.css';
import { Settings } from './Settings';

createRoot(document.getElementById('app')!).render(<Settings />);
