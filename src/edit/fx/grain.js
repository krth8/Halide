// Grain: film grain sized relative to the frame, new every frame in motion (shared post chain).
export default {
  id: 'grain', label: 'Grain', icon: '░',
  amount: 'grain',
  params: [
    { key: 'grain', label: 'Amount', min: 0, max: 1, step: 0.01, def: 0, add: 0.35 },
    { key: 'grainSize', label: 'Size', min: 1, max: 4, step: 0.05, def: 1.4 },
  ],
};
