/* Privacy-preserving UI event instrumentation. No values, text, geometry, or paths. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory;
    else root.UsageEvents = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (host) {
    'use strict';
    const CONTROL_IDS = new Set(['work-order-search','work-order-filter','eda-dock-close','eda-dock-toggle','eda-layers-toggle','eda-reset','eda-tab-images','eda-tab-properties','eda-tab-components','eda-tab-changes','copy-btn','fit-btn','zoom-in-btn','zoom-out-btn','run-btn','open-python','related-files','usage-logs','shape-menu-btn','primitive-close','primitive-place','primitive-center','primitive-kind','primitive-length','primitive-width1','primitive-width2','primitive-layer','primitive-rotation','instruction-list-btn','instructions-close','instructions-refresh','copy-open-instructions','queue-instruction','intent-action','intent-text','intent-apply','img-insert-btn','img-move-btn','img-phase-btn','img-align-btn','image-align','image-cancel','image-fit','image-fit-scope','image-select','image-reset','image-remove','image-place','image-lower','image-raise','image-visible','image-locked','image-opacity','image-display','image-border','image-contour-color','image-contour-threshold','image-contour-width','image-appearance','image-layers','route-btn','route-close','route-finish','route-apply','route-move-segment','route-points','route-width','route-layer','route-order','shape-properties']);
    const MODES = new Set(['select','rectangle','circle','line','polygon','delete','snap','route']);
    const SHAPES = new Set(['rectangle','circle','line','polygon','taper','straight','pad']);
    const INSTRUCTION_ACTIONS = new Set(['copyRef','copyDetails','done','revert','select','comment']);
    const SHORTCUTS = new Map([
        ['1', 'mode-select'], ['2', 'mode-rectangle'], ['3', 'mode-circle'], ['4', 'mode-line'], ['5', 'mode-polygon'], ['6', 'mode-route'],
        ['s', 'snap'], ['escape', 'cancel'], ['delete', 'delete-drawn'], ['backspace', 'delete-drawn'], ['tab', 'shape-properties'], ['enter', 'finish-route'],
    ]);
    function attach(config) {
        const target = config && config.root && typeof config.root.addEventListener === 'function' ? config.root : null;
        const send = config && typeof config.send === 'function' ? config.send : function () {};
        if (!target) return { dispose: function () {} };
        const sessionId = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; let seq = 0; let disposed = false; let wheelTimer = null; let wheelCount = 0;
        function emit(action, control, extra) { if (disposed) return; const event = { action, timestamp: new Date().toISOString(), sessionId, seq: ++seq, source: 'ui', phase: 'intent', outcome: 'unknown', control }; if (extra) Object.assign(event, extra); try { send(event); } catch (_) {} }
        function controlFor(node) {
            let element = node;
            for (let i = 0; element && i < 10; i++, element = element.parentElement) {
                if (element.dataset && element.dataset.mode && MODES.has(element.dataset.mode)) return `mode.${element.dataset.mode}`;
                if (element.dataset && element.dataset.shape && SHAPES.has(element.dataset.shape)) return `shape.${element.dataset.shape}`;
                if (element.dataset && element.dataset.action && INSTRUCTION_ACTIONS.has(element.dataset.action)) return `instruction.${element.dataset.action.toLowerCase()}`;
                if (typeof element.id === 'string' && CONTROL_IDS.has(element.id)) return element.id;
            }
            return null;
        }
        function onClick(event) { try { const control = controlFor(event && event.target); if (control) emit('ui.control', control); } catch (_) {} }
        function onChange(event) { try { const control = controlFor(event && event.target); if (control) emit('ui.change', control); } catch (_) {} }
        function onKeydown(event) { try { if (!event || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target && event.target.tagName) || (event.target && event.target.isContentEditable)) return; const key = String(event.key || '').toLowerCase(); const modified = !!(event.ctrlKey || event.metaKey || event.altKey); let name = modified ? null : SHORTCUTS.get(key); if (key === 'c' && (event.ctrlKey || event.metaKey) && event.shiftKey) name = 'copy-selection'; if (key === 'a' && (event.ctrlKey || event.metaKey)) name = 'apply-instruction'; if ((event.ctrlKey || event.metaKey) && ['arrowleft','arrowright','arrowup','arrowdown'].includes(key)) name = `image-${key.slice(5)}`; if (name) emit('ui.shortcut', name); } catch (_) {} }
        function onWheel(event) { try { let node = event && event.target; let inMap = false; for (let i = 0; node && i < 10; i++, node = node.parentElement) { if (node.id === 'map' || (typeof node.className === 'string' && node.className.split(/\s+/).includes('ol-viewport'))) { inMap = true; break; } } if (!inMap) return; wheelCount++; if (wheelTimer === null) wheelTimer = setTimeout(() => { const count = wheelCount; wheelCount = 0; wheelTimer = null; emit('view.wheel', 'view.wheel', { count }); }, 200); } catch (_) {} }
        target.addEventListener('click', onClick); target.addEventListener('change', onChange); target.addEventListener('keydown', onKeydown); target.addEventListener('wheel', onWheel, { passive: true });
        return { dispose: function () { if (disposed) return; disposed = true; target.removeEventListener('click', onClick); target.removeEventListener('change', onChange); target.removeEventListener('keydown', onKeydown); target.removeEventListener('wheel', onWheel); if (wheelTimer !== null) { clearTimeout(wheelTimer); wheelTimer = null; wheelCount = 0; } } };
    }
    return { attach, controls: Array.from(CONTROL_IDS), modes: Array.from(MODES), shapes: Array.from(SHAPES), instructionActions: Array.from(INSTRUCTION_ACTIONS) };
});
