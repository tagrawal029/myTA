import { createRoot } from 'react-dom/client';
import { spriteCss } from '../shared/sprite/spriteCss';
import { Marks } from './Marks';

const style = document.createElement('style');
style.textContent = `${spriteCss}
html, body, #app { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; pointer-events: none; }`;
document.head.prepend(style);
createRoot(document.getElementById('app')!).render(<Marks />);
