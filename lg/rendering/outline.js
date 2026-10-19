import { hexToColorArray } from '../animation/colors.js';
// Keeps the outline uniforms of one glass in step with its surface's
// `<prefix>-outline-*` settings. A width of 0 is how the shader turns the
// outline off.
export class OutlineBinding {
    _settings;
    _prefix;
    _uniforms;
    _repaintIfDirty;
    _ids = [];
    constructor(_settings, _prefix, _uniforms, _repaintIfDirty) {
        this._settings = _settings;
        this._prefix = _prefix;
        this._uniforms = _uniforms;
        this._repaintIfDirty = _repaintIfDirty;
    }
    initialize() {
        this._apply();
        for (const suffix of ['enabled', 'width', 'color']) {
            this._ids.push(this._settings.connect(`changed::${this._prefix}-outline-${suffix}`, () => {
                this._apply();
                this._repaintIfDirty();
            }));
        }
    }
    clear() {
        this._ids.forEach(id => this._settings.disconnect(id));
        this._ids = [];
    }
    _apply() {
        const s = this._settings;
        const p = this._prefix;
        const [r, g, b] = hexToColorArray(s.get_string(`${p}-outline-color`));
        this._uniforms.set('outline_width', s.get_boolean(`${p}-outline-enabled`) ? s.get_double(`${p}-outline-width`) : 0.0);
        this._uniforms.set('outline_r', r);
        this._uniforms.set('outline_g', g);
        this._uniforms.set('outline_b', b);
    }
}
