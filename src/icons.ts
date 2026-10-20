const svg = (body: string, size = 24) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const art = (body: string) =>
  `<svg class="art" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  person: svg('<circle cx="12" cy="5" r="2.5"/><path d="M12 8v7M8 11l4-1 4 1M9 21l3-6 3 6"/>'),
  tablet: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M12 16h.01"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4L2.4 16a2 2 0 0 1 2.8-2.8L7 15"/>'),
  play: svg('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  note: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  replay: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  home: svg('<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>'),
  blade: art('<path d="M10 54L46 18" stroke="#ff2d6a"/><path d="M54 54L18 18" stroke="#1fb8ff"/><path d="M46 18l6-8M18 18l-6-8" stroke="#fff"/><rect x="5" y="49" width="10" height="5" rx="2" transform="rotate(-45 10 51)" fill="#ff2d6a"/><rect x="49" y="49" width="10" height="5" rx="2" transform="rotate(45 54 51)" fill="#1fb8ff"/>'),
  wheel: art('<circle cx="32" cy="34" r="22"/><circle cx="32" cy="34" r="6"/><path d="M10 30h16M38 30h16M32 40v16"/>'),
  glove: art('<path d="M20 56V30l-6-12a4 4 0 0 1 7-4l5 9V10a4 4 0 0 1 8 0v12-14a4 4 0 0 1 8 0v16-10a4 4 0 0 1 8 0v20c0 12-6 22-18 22z"/>'),
  bat: art('<path d="M12 52l26-26 6 6-26 26z"/><path d="M44 32l8-8a4 4 0 0 0-6-6l-8 8"/><circle cx="50" cy="50" r="5"/>'),
  racket: art('<ellipse cx="38" cy="24" rx="14" ry="18" transform="rotate(35 38 24)"/><path d="M28 38L12 56"/><path d="M30 14l16 20M26 22l16 20M38 10l-8 26M46 16l-8 26"/>'),
  fit: art('<path d="M8 26v12M14 20v24M50 20v24M56 26v12M14 32h36"/>'),
  mountain: art('<path d="M4 54l18-30 10 16 8-12 20 26z"/><path d="M22 24l4 8M40 28l-3 6"/><circle cx="48" cy="14" r="5"/>'),
};
