// Texture: fine detail; negative smooths (e.g. skin) (shared post chain).
export default {
  id: 'texture', label: 'Texture', icon: '▦',
  amount: 'texture',
  params: [
    { key: 'texture', label: 'Amount', min: -1, max: 1, step: 0.01, def: 0, add: 0.3 },
  ],
};
