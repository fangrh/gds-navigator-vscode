const fs = require('fs');
const path = require('path');

function renderViewer(options = {}) {
  const root = path.join(__dirname, '..');
  // A trusted local snapshot lets the profiler compare revisions with identical assets.
  let html = fs.readFileSync(options.viewerPath || path.join(root, 'webview', 'viewer.html'), 'utf8').replace(/\r\n/g, '\n');
  const replace = (token, value) => { html = html.replace(token, value); };
  replace('__OL_CSS__', '<link rel="stylesheet" href="/media/ol.css">');
  replace('__OL_JS__', '<script src="/media/ol.js"></script>');
  replace('__MARKER_JS__', '<script src="/webview/numbered-marker-alignment.js"></script>');
  replace('__OVERLAY_JS__', '<script src="/webview/microscope-overlay.js"></script>');
  replace('__PRIMITIVE_JS__', '<script src="/webview/layout-primitives.js"></script>');
  replace('__PORT_JS__', '<script src="/webview/port-overlay.js"></script>');
  replace('__CHOOSER_JS__', '<script src="/webview/component-chooser.js"></script>');
  replace('__PROPERTIES_JS__', '<script src="/webview/shape-properties.js"></script>');
  replace('__SOURCE_SELECTION_JS__', '<script src="/webview/source-selection.js"></script>');
  replace('__EDA_JS__', '<script src="/webview/eda-workbench.js"></script>');
  replace('__EDA_CSS__', '<link rel="stylesheet" href="/webview/eda-workbench.css">');
  replace('__USAGE_JS__', '<script src="/webview/usage-events.js"></script>');
  const routes = ['rust-geometry.js', 'manhattan-route.js', 'route-planner.js', 'route-image-mask.js', 'route-assist.js'];
  const routeWorker = ['rust-geometry.js', 'route-planner.js'].map(file => fs.readFileSync(path.join(root, 'webview', file), 'utf8')).join('\n');
  replace('__ROUTE_JS__', '<script src="/media/geometry-kernel.js"></script>' + routes.map(file => `<script src="/webview/${file}"></script>`).join('') + `<script>window.routePlannerWorkerSource=${JSON.stringify(routeWorker).replace(/</g, '\\u003c')};</script>`);
  replace('__REVIEW_JS__', '<script src="/webview/layout-review.js"></script>');
  replace('__REVIEW_UI_JS__', '<script src="/webview/review-tools.js"></script>');
  const workerSource = ['numbered-marker-alignment.js', 'numbered-marker-worker.js'].map(name => fs.readFileSync(path.join(root, 'webview', name), 'utf8')).join('\n');
  replace('__WORKER_SOURCE__', `<script>window.numberedMarkerWorkerSource=${JSON.stringify(workerSource).replace(/</g, '\\u003c')};</script>`);
  if (options.browser) {
    html = html.replace('</head>', '<link rel="stylesheet" href="/web/browser-host.css"><script src="/web/browser-host.js"></script>\n</head>');
  }
  return html;
}

module.exports = { renderViewer };
