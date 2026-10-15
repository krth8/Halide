// Halation: the red-orange glow film shows around bright edges (shared post chain).
export default {
  id: 'halation', label: 'Halation', icon: '◉',
  amount: 'halation',
  params: [
    { key: 'halation', label: 'Amount', min: 0, max: 1, step: 0.01, def: 0, add: 0.4 },
  ],
};
