// Webview entry: expose OpenLayers as the global `ol` that viewer.html expects.
// The npm package's main index does NOT re-export the sub-namespaces
// (ol.source, ol.layer, ol.style, ...), so each module is imported and
// attached explicitly to match the CDN full build (dist/ol.js) that the
// original superGDS Studio viewer.html was written against.
import * as ol from 'ol';
import * as olSource from 'ol/source';
import * as olLayer from 'ol/layer';
import * as olStyle from 'ol/style';
import * as olFormat from 'ol/format';
import * as olInteraction from 'ol/interaction';
import * as olDrawModule from 'ol/interaction/Draw';
import * as olGeom from 'ol/geom';
import * as olExtent from 'ol/extent';
import * as olEvents from 'ol/events';
import * as olEventsCondition from 'ol/events/condition';
import * as olProj from 'ol/proj';

// createBox is exported by ol/interaction/Draw but not re-exported by the
// ol/interaction index; viewer.html calls ol.interaction.Draw.createBox().
// Attach it to the real class — spreading a class into a plain object would
// break `new ol.interaction.Draw(...)`.
const Draw = olInteraction.Draw as unknown as { createBox?: unknown };
Draw.createBox = olDrawModule.createBox;

const full = {
    ...ol,
    source: olSource,
    layer: olLayer,
    style: olStyle,
    format: olFormat,
    interaction: olInteraction,
    geom: olGeom,
    extent: olExtent,
    proj: olProj,
    events: { ...olEvents, condition: olEventsCondition },
};

(window as any).ol = full;
