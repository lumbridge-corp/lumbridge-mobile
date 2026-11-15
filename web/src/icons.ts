// Inline icons. Static strings only, never built from data.
const stroke = (body: string, size = 24) =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  today: stroke('<circle cx="12" cy="12" r="4"/><path d="M12 3v1.750M12 19.250V21M3 12h1.750M19.250 12H21M5.640 5.640l1.240 1.240M17.120 17.120l1.240 1.240M5.640 18.360l1.240-1.240M17.120 6.880l1.240-1.240"/>'),
  agents: stroke('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h3.5"/>'),
  apps: stroke('<rect x="4" y="4" width="6.750" height="6.750" rx="2"/><rect x="13.250" y="4" width="6.750" height="6.750" rx="2"/><rect x="4" y="13.250" width="6.750" height="6.750" rx="2"/><rect x="13.250" y="13.250" width="6.750" height="6.750" rx="2"/>'),
  infra: stroke('<rect x="4" y="4.500" width="16" height="6.500" rx="2"/><rect x="4" y="13" width="16" height="6.500" rx="2"/><path d="M7.750 7.750h.01M7.750 16.250h.01M11.500 7.750H16M11.500 16.250H16"/>'),
  assistant: `<svg class="ic" viewBox="0 0 512 512" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M300 150C372 138 428 190 414 266C398 352 296 442 122 462C102 464 96 444 114 436C208 396 236 330 226 252C219 192 250 156 300 150Z"/><path d="M318 150C318 112 340 86 374 72" fill="none" stroke="currentColor" stroke-width="28" stroke-linecap="round"/></svg>`,
  notes: stroke('<path d="M6.5 3.5h8l4 4v13h-12z"/><path d="M14.5 3.5v4h4M9.5 12.5h5M9.5 16h5"/>'),
  thoughts: stroke('<path d="M7.500 16.500a4 4 0 0 1-.7-7.940 5.250 5.250 0 0 1 10.100-.900 4.500 4.500 0 0 1-.4 8.840z"/><circle cx="8.500" cy="20" r="1.250"/>'),
  files: stroke('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.750"/><path d="m4 17 4.500-4.500 3.500 3.500 2.500-2.500L20 18.500"/>'),
  camera: stroke('<path d="M4 8.500a2 2 0 0 1 2-2h2l1.500-2h5L16 6.500h2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.500" r="3.500"/>', 26),
  image: stroke('<rect x="3.500" y="4.500" width="17" height="15" rx="2.500"/><circle cx="9" cy="9.500" r="1.750"/><path d="m4 17.500 5-5 4 4 2.500-2.500 4.500 4.500"/>', 26),
  social: stroke('<rect x="6.500" y="3" width="11" height="18" rx="2.500"/><circle cx="12" cy="10.500" r="2.750"/><path d="M9 16.500h6"/>'),
  car: stroke('<path d="m5 11.500 1.600-4.300A2.500 2.500 0 0 1 8.950 5.500h6.100a2.500 2.500 0 0 1 2.350 1.700L19 11.500"/><rect x="3.500" y="11.500" width="17" height="6.500" rx="2"/><path d="M6.500 18v1.500M17.500 18v1.500M7.500 14.750h.01M16.500 14.750h.01"/>'),
  library: stroke('<path d="M4.500 4.500h3.500v15H4.500zM10.250 4.500h3.500v15h-3.500z"/><path d="m14.800 5.600 3.300-.900 3.600 14-3.300.900z"/><path d="M10.250 8h3.500M4.500 16h3.500"/>'),
  lumbridge: stroke('<path d="M3 8.500h18M5 8.500V19M19 8.500V19"/><path d="M5 17a7 6.500 0 0 1 14 0"/><path d="M9 8.500v3M15 8.500v3M12 8.500v2"/>'),
  tools: stroke('<path d="M14.700 6.300a4 4 0 0 0 5 5L12 19a2.120 2.120 0 0 1-3-3l7.700-7.700a4 4 0 0 1-1.900-2.100z"/><path d="M14.700 6.300 17 4l3 3-2.300 2.300"/><path d="m5 5 4.500 4.500M4 9l5-5"/>'),
  tv: stroke('<rect x="3" y="5" width="18" height="12.500" rx="2"/><path d="M8.500 20.500h7M14 9.250h3.500M14 12.750h3.500"/>'),
  speaker: stroke('<path d="M4 9.5h3.5L12 5.500v13l-4.500-4H4z"/><path d="M15.500 9.250a4 4 0 0 1 0 5.500M18 6.750a7.500 7.500 0 0 1 0 10.500"/>', 16),
  music: stroke('<path d="M9 18.5V6.500l10-2v11.500"/><circle cx="6.500" cy="18.500" r="2.500"/><circle cx="16.500" cy="16" r="2.500"/>'),
  tasks: stroke('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>'),
  settings: stroke('<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2"/><circle cx="9" cy="16.5" r="2"/>'),
  instagram: stroke('<rect x="4" y="4" width="16" height="16" rx="4.500"/><circle cx="12" cy="12" r="3.600"/><circle cx="16.800" cy="7.200" r=".6" fill="currentColor"/>', 14),
  x: stroke('<path d="M5 4.500h3.500L19 19.500h-3.500zM18.500 4.500l-5.300 6.200M10.800 13.300 5.500 19.500"/>', 14),
  lock: stroke('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>', 16),
  chevron: stroke('<path d="m6.500 9.250 5.500 5.500 5.500-5.500"/>', 18),
  back: stroke('<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>'),
  search: stroke('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>', 18),
  close: stroke('<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>'),
  more: `<svg class="ic" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></svg>`,
  pin: `<svg class="ic" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M9 3.5h6l-.8 6 3.3 3.6v1.9h-4.5V21L12 22l-1-1v-6H6.500v-1.900L9.800 9.500z"/></svg>`,
  group: stroke('<path d="M4 6h6M4 18h6M4 12h6M14 6h6M14 12h6M14 18h6"/>', 22),
  list: stroke('<path d="M4.500 6.500h15M4.500 12h15M4.500 17.500h15"/>', 22),
  down: stroke('<path d="M12 5v13.500M6 12.500l6 6 6-6"/>', 20),
  mic: stroke('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3"/>', 22),
  send: stroke('<path d="M12 19V6M6.500 11.500 12 6l5.500 5.500"/>', 22),
  size: `<svg class="ic" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><text x="1.500" y="18" font-size="17" font-weight="600" font-family="system-ui,sans-serif">A</text><text x="13" y="18" font-size="11" font-weight="600" font-family="system-ui,sans-serif">a</text></svg>`,
  mark: `<svg class="ic" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" fill="currentColor"><rect x="4" y="3" width="9" height="17"/><rect x="4" y="22" width="17" height="7"/><rect x="23" y="22" width="7" height="7"/></svg>`,
};

export function icon(name: keyof typeof icons, cls = ""): HTMLElement {
  const s = document.createElement("span");
  s.className = cls ? `icw ${cls}` : "icw";
  s.innerHTML = icons[name];
  return s;
}
