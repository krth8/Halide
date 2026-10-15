import '../shared/theme.css';
import './launcher.css';
import { boot } from '../shared/boot';
import { halideMark, PROCESS_GLYPH, EDIT_GLYPH } from '../shared/brand';

const $ = (id: string) => document.getElementById(id)!;
$('mark').innerHTML = halideMark();
$('gProcess').innerHTML = PROCESS_GLYPH;
$('gEdit').innerHTML = EDIT_GLYPH;
$('foot').textContent = `v${__APP_VERSION__} · WebGPU · works offline once loaded`;

boot();
