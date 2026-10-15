export interface CubeLut { id: string; name: string; size: number; data: Float32Array }

/** Parses an Adobe/Resolve .cube 3D LUT (red varies fastest). Domain min/max are honoured. */
export function parseCube(text: string, name: string): CubeLut {
  let size = 0;
  let min = [0, 0, 0], max = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) continue;
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('1D LUTs are not supported, only 3D');
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('DOMAIN_MIN')) { min = line.split(/\s+/).slice(1).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { max = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/.test(up)) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!size || vals.length < size * size * size * 3) throw new Error('Invalid .cube file');
  const data = new Float32Array(size * size * size * 4);
  for (let i = 0, j = 0; i < size * size * size; i++, j += 3) {
    data[i * 4] = (vals[j] - min[0]) / (max[0] - min[0]);
    data[i * 4 + 1] = (vals[j + 1] - min[1]) / (max[1] - min[1]);
    data[i * 4 + 2] = (vals[j + 2] - min[2]) / (max[2] - min[2]);
    data[i * 4 + 3] = 1;
  }
  return { id: 'lut_' + Date.now().toString(36), name: name.replace(/\.cube$/i, ''), size, data };
}
