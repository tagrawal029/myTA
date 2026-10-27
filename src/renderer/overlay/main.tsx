import { createRoot } from 'react-dom/client';
import { spriteCss } from '../shared/sprite/spriteCss';
import { Overlay } from './Overlay';
import './overlay.css';

const style = document.createElement('style');
style.textContent = spriteCss;
document.head.prepend(style);
createRoot(document.getElementById('app')!).render(<Overlay />);
