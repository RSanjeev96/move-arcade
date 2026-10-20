import '@fontsource/outfit/400.css';
import '@fontsource/outfit/600.css';
import '@fontsource/outfit/800.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import './styles.css';
import { App } from './app';

const root = document.getElementById('app')!;
new App(root);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
