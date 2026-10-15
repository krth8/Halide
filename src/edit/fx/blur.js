// Blur: tilt-shift band, radial (sharp centre) or the whole frame (shared post chain).
export default {
  id: 'blur', label: 'Blur', icon: '◌',
  amount: 'blur',
  params: [
    { key: 'blurMode', label: 'Shape', options: [[0, 'Tilt-shift'], [1, 'Radial'], [2, 'Whole frame']], def: 2 },
    { key: 'blur', label: 'Amount', min: 0, max: 1, step: 0.01, def: 0, add: 0.4 },
  ],
};
