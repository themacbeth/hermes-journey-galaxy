// System looks: each journey gets its own 4-shade palette and star type.
// Palettes are spaced around the hue wheel (then by lightness) so neighbours never look alike.
const PALETTES = [
  ["#4a84fe", "#5f9bff", "#3a6cf0", "#9cc4ff"], // blue
  ["#22d3b6", "#1aa8c7", "#3ee0c8", "#9af0dc"], // teal
  ["#ffb02e", "#ffc457", "#f29a12", "#ffe0a6"], // amber
  ["#c06bff", "#d38fff", "#a64ff0", "#ead1ff"], // violet
  ["#b6ec3a", "#cff56a", "#97d420", "#e6fab8"], // lime
  ["#ff7a45", "#ff9466", "#f0602e", "#ffc9ad"], // coral
  ["#3fd2ff", "#7ae2ff", "#1fb4e8", "#c4f1ff"], // sky
  ["#ff40d8", "#e85cff", "#ff7ae6", "#ffc4f2"], // magenta
  ["#f2dc3c", "#fff07a", "#d9c020", "#fff7c4"], // yellow
  ["#3be36b", "#26c457", "#7af59a", "#c4fad2"], // green
  ["#ff3b3b", "#ff5c5c", "#e02a3a", "#ffb3b3"], // red
  ["#6d5cff", "#8a7dff", "#5545e8", "#c4bdff"], // indigo
  ["#c8d4ec", "#9fb4dc", "#e8eef8", "#7f96c4"], // silver
  ["#ff5c9a", "#ff80b2", "#f03f80", "#ffc2d9"], // rose
  ["#9dfcd0", "#6ef0b8", "#c8ffe6", "#4fd9a0"], // mint
  ["#d9773a", "#c05f28", "#eb9a5e", "#f6cba8"], // copper
  ["#f3e3c3", "#e6cf9f", "#fff4dc", "#d4b98a"], // ivory
];
const STARS = ["corona", "pulsar", "nebula", "binary", "ringed"];
const HEX = /^#[0-9a-f]{6}$/i;

// Stable: the same name keeps the same look when you add more journeys.
function hashName(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

export function assignLooks(journeys) {
  const used = new Set();
  return journeys.map((j) => {
    let pal = Array.isArray(j.palette) && j.palette.length && j.palette.every((c) => HEX.test(c)) ? j.palette : null;
    if (!pal && HEX.test(j.color || "")) pal = [j.color, j.color, j.color, j.color];
    if (!pal) {
      let k = hashName(j.name) % PALETTES.length;
      for (let n = 0; n < PALETTES.length && used.has(k); n++) k = (k + 1) % PALETTES.length;
      used.add(k); pal = PALETTES[k];
    }
    const star = STARS.includes(j.star) ? j.star : STARS[hashName(j.name + "*") % STARS.length];
    return { ...j, palette: pal, color: pal[0], star };
  });
}
