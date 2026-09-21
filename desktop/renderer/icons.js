// Small hand-picked line-icon set (1.6px stroke, 18px grid) so the UI doesn't
// rely on emoji glyphs, which render inconsistently and read as a placeholder
// rather than a real icon.
const ICONS = {
  sun: '<path d="M9 3v1.6M9 13.4V15M3 9h1.6M13.4 9H15M4.9 4.9l1.1 1.1M12 12l1.1 1.1M13.1 4.9 12 6M6 12l-1.1 1.1"/><circle cx="9" cy="9" r="3.2"/>',
  moon: '<path d="M14.5 10.4A5.6 5.6 0 0 1 7.6 3.5a5.8 5.8 0 1 0 6.9 6.9Z"/>',
  search: '<circle cx="8.2" cy="8.2" r="5"/><path d="m15 15-3.4-3.4"/>',
  plus: '<path d="M9 3.5v11M3.5 9h11"/>',
  chevronLeft: '<path d="m11 3.5-5.5 5.5L11 14.5"/>',
  pencil: '<path d="M11.6 2.9a1.6 1.6 0 0 1 2.3 2.3L5.6 13.5l-3 .7.7-3Z"/>',
  trash: '<path d="M3.5 5.2h11M7.3 5.2V3.6h3.4v1.6M6 5.2v8.2a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V5.2M7.5 8v3.4M10.5 8v3.4"/>',
  copy: '<rect x="6.2" y="6.2" width="7.6" height="7.6" rx="1.2"/><path d="M11.8 6.2V4.8a1 1 0 0 0-1-1H4.8a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.4"/>',
  folder: '<path d="M2.5 5.2a1 1 0 0 1 1-1H7l1.4 1.6h6.1a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1Z"/>',
  file: '<path d="M5.5 2.5h5l3 3v9.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1Z"/><path d="M10.5 2.5v3h3"/>',
  more: '<circle cx="9" cy="4.5" r="1"/><circle cx="9" cy="9" r="1"/><circle cx="9" cy="13.5" r="1"/>',
  mic: '<rect x="6.8" y="2.5" width="4.4" height="7.5" rx="2.2"/><path d="M4.2 8.5a4.8 4.8 0 0 0 9.6 0M9 13.3v2.2M6.6 15.5h4.8"/>',
  winMinimize: '<path d="M3.5 9h11"/>',
  winMaximize: '<rect x="4" y="4" width="10" height="10" rx="1"/>',
  winClose: '<path d="M4 4l10 10M14 4 4 14"/>',
  gear: '<circle cx="9" cy="9" r="2.3"/><path d="M9 2.6v1.7M9 13.7v1.7M15.4 9h-1.7M4.3 9H2.6M13.2 4.8l-1.2 1.2M5 12l-1.2 1.2M13.2 13.2 12 12M5 6 3.8 4.8"/>',
  help: '<circle cx="9" cy="9" r="6.3"/><path d="M6.9 6.9a2.1 2.1 0 1 1 3 1.9c-.7.4-1.2.9-1.2 1.7v.3"/><circle cx="8.9" cy="12.7" r="0.15" fill="currentColor" stroke-width="0.8"/>',
  chat: '<path d="M3 4.5h12v8H8.5L5 15.5v-3H3z"/>',
  star: '<path d="M9 2.3l1.9 3.9 4.3.6-3.1 3 .7 4.3L9 12.1l-3.8 2 .7-4.3-3.1-3 4.3-.6Z"/>',
};

function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

// A small faceted gem, filled (not the stroke-icon set above) so it reads as
// "Ruby" rather than a generic line icon - used as the "thinking" indicator
// while waiting on a Gemini reply, since a plain "..." looked indistinguishable
// from a frozen/broken UI.
function rubyGemSvg(size = 16) {
  return `<svg class="thinking-gem" width="${size}" height="${size}" viewBox="0 0 18 18">
    <path d="M9 1.5 14.5 6 9 16.5 3.5 6Z" fill="var(--accent)"/>
    <path d="M9 1.5 14.5 6 9 6Z" fill="rgba(255,255,255,0.28)"/>
    <path d="M9 1.5 3.5 6 9 6Z" fill="rgba(255,255,255,0.12)"/>
    <path d="M3.5 6 9 6 9 16.5Z" fill="rgba(0,0,0,0.18)"/>
  </svg>`;
}
