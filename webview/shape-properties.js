/* Compact placement editor for drawn shapes and read-only GDS selections. */
(function (root) {
    'use strict';
    const STYLE_ID = 'gds-shape-properties-style';
    function mount(config) {
        if (!config || !config.container || typeof config.onApply !== 'function' || typeof config.onMode !== 'function') throw new Error('ShapeProperties requires container, onApply and onMode');
        const container = config.container, onApply = config.onApply, onMode = config.onMode, onClose = typeof config.onClose === 'function' ? config.onClose : function () {};
        if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
            const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = '.gds-shape-properties{position:absolute;right:60px;bottom:12px;width:260px;max-width:calc(100% - 80px);max-height:calc(100% - 24px);overflow:auto;z-index:31;padding:10px;color:#e2e5ef;background:#252638;border:1px solid #626780;border-radius:7px;font:12px sans-serif;box-shadow:0 4px 18px #0005}.gds-shape-properties[hidden]{display:none}.gds-shape-properties header{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}.gds-shape-properties .close{padding:0 5px;font-size:18px;line-height:18px}.gds-shape-properties label{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:5px 0}.gds-shape-properties input{width:125px;box-sizing:border-box;color:#e2e5ef;background:#35394d;border:1px solid #626780;border-radius:4px;padding:4px}.gds-shape-properties .modes{display:flex;gap:4px;margin-top:8px}.gds-shape-properties button{color:#e2e5ef;background:#35394d;border:1px solid #626780;border-radius:4px;padding:4px 7px;cursor:pointer}.gds-shape-properties .help{color:#a6adc8;line-height:1.35;margin:7px 0}.gds-shape-properties .error{color:#ffb0a8;min-height:16px;margin-top:4px}'; document.head.appendChild(style);
        }
        const panel = document.createElement('section'); panel.className = 'gds-shape-properties'; panel.hidden = true; panel.setAttribute('aria-label', 'Shape properties');
        const header = document.createElement('header'), title = document.createElement('strong'), close = document.createElement('button'); title.textContent = 'Shape properties'; close.textContent = '×'; close.className = 'close'; close.type = 'button'; close.setAttribute('aria-label', 'Close shape properties'); close.title = 'Close'; header.append(title, close); panel.appendChild(header);
        const fields = {}; const names = [['x', 'X'], ['y', 'Y'], ['width', 'Width'], ['height', 'Height'], ['rotation', 'Rotation (degrees)']];
        names.forEach(([name, label]) => { const row = document.createElement('label'), text = document.createElement('span'), input = document.createElement('input'); text.textContent = label; input.type = 'number'; input.step = 'any'; input.dataset.field = name; row.append(text, input); panel.appendChild(row); fields[name] = input; });
        const help = document.createElement('p'); help.className = 'help'; panel.appendChild(help);
        const error = document.createElement('div'); error.className = 'error'; error.setAttribute('role', 'alert'); panel.appendChild(error);
        const modes = document.createElement('div'); modes.className = 'modes'; const modeButtons = [['move', 'Move'], ['resize', 'Resize'], ['rotate', 'Rotate']].map(([name, label]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.dataset.mode = name; b.addEventListener('click', () => onMode(name)); modes.appendChild(b); return b; }); panel.appendChild(modes);
        const apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply'; panel.appendChild(apply); container.appendChild(panel);
        let previousFocus = null, editable = false; const originalValues = {}, displayedValues = {};
        function hide() { panel.hidden = true; error.textContent = ''; if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus(); onClose(); }
        close.addEventListener('click', hide);
        panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); } });
        apply.addEventListener('click', () => {
            if (Object.keys(fields).some(name => String(fields[name].value).trim() === '')) { error.textContent = 'Enter values for X, Y, width, height, and rotation.'; return; }
            const value = {}; for (const name of Object.keys(fields)) { value[name] = fields[name].value === displayedValues[name] ? originalValues[name] : Number(fields[name].value); }
            if (![value.x, value.y, value.rotation].every(Number.isFinite) || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width < 0 || value.height < 0 || (value.width === 0 && value.height === 0)) { error.textContent = 'Enter finite X, Y, and rotation values with non-negative width and height; at least one size must be positive.'; return; }
            error.textContent = ''; try { onApply(value); } catch (cause) { error.textContent = cause && cause.message ? cause.message : 'Could not apply shape properties.'; }
        });
        function show(value) {
            if (!value || typeof value !== 'object') throw new Error('Shape properties require a value object');
            if (panel.hidden) previousFocus = document.activeElement;
            editable = value.editable !== false;
            title.textContent = 'Shape properties'; title.title = value.label || '';
            for (const name of Object.keys(fields)) { originalValues[name]=Number(value[name]); displayedValues[name]=Number.isFinite(originalValues[name])?String(Number(originalValues[name].toPrecision(9))):''; fields[name].value=displayedValues[name];fields[name].title='Full precision: '+String(value[name]); fields[name].disabled = !editable; }
            help.textContent = editable ? 'X/Y are the center in µm; width/height use local axes; rotation is counter-clockwise degrees. Use Move, Resize, or Rotate for mouse editing.' : 'GDS geometry is read-only. Select a drawn proposal to edit its placement.';
            modes.hidden = !editable; apply.hidden = !editable; error.textContent = ''; panel.hidden = false;
            const first = fields.x; if (first && editable && typeof first.focus === 'function') first.focus();
        }
        container.hidden = false;
        return { show, hide, isOpen: () => !panel.hidden };
    }
    root.ShapeProperties = { mount };
})(globalThis);
