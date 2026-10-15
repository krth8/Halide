// Clarity: large-radius midtone contrast; negative softens (shared post chain).
export default {
  id: 'clarity', label: 'Clarity', icon: '◈',
  amount: 'clarity',
  params: [
    { key: 'clarity', label: 'Amount', min: -1, max: 1, step: 0.01, def: 0, add: 0.3 },
  ],
};
