// Dehaze: removes (or adds) atmospheric haze (shared post chain).
export default {
  id: 'dehaze', label: 'Dehaze', icon: '☁',
  amount: 'dehaze',
  params: [
    { key: 'dehaze', label: 'Amount', min: -1, max: 1, step: 0.01, def: 0, add: 0.3 },
  ],
};
