import { mountViewer } from '@file-viewer/web';
import pdfRenderer from '@file-viewer/renderer-pdf';

export function mountDocument(container, file, onStateChange) {
  const base = '/vendor/file-viewer/pdfjs/';
  const controller = mountViewer(container, {
    file, filename: file.name, type: 'pdf', onStateChange,
    options: {
      locale: 'zh-CN', theme: 'light', styleIsolation: 'shadow',
      rendererMode: 'replace', renderers: [pdfRenderer],
      toolbar: { position: 'top', download: false, print: false, exportHtml: false, theme: false, zoom: false, search: true },
      pdf: {
        streaming: false, toolbar: true, navigation: true, defaultNavigationVisible: false,
        workerUrl: base + 'legacy/build/pdf.worker.mjs',
        cMapUrl: base + 'cmaps/', standardFontDataUrl: base + 'standard_fonts/',
        wasmUrl: base + 'wasm/', cjkFontFallbackPath: '/vendor/file-viewer/cjk/',
      },
    },
  });
  const shell = container.shadowRoot?.querySelector('.file-viewer-web-shell');
  if (shell) {
    shell.style.setProperty('--file-viewer-font', `13px/1.5 ${getComputedStyle(container).fontFamily}`);
    shell.style.setProperty('--file-viewer-button-hover-color', '#1674df');
    shell.style.setProperty('--file-viewer-button-hover-bg', '#edf4ff');
  }
  return controller;
}
