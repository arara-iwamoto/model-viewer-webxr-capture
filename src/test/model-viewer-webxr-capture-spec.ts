/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

import {expect} from 'chai';

import {_getSubscriberCount, findSymbol} from '../host-bridge.js';
import {ModelViewerWebXRCapture} from '../model-viewer-webxr-capture.js';

suite('<model-viewer-webxr-capture>', () => {
  let element: ModelViewerWebXRCapture;

  setup(() => {
    element = document.createElement('model-viewer-webxr-capture') as
        ModelViewerWebXRCapture;
    document.body.appendChild(element);
  });

  teardown(() => {
    element.remove();
  });

  test('registers a custom element', () => {
    expect(customElements.get('model-viewer-webxr-capture')).to.exist;
    expect(element).to.be.instanceOf(ModelViewerWebXRCapture);
  });

  test('does not show the shutter without a host', async () => {
    await element.updateComplete;
    expect(element.classList.contains('shutter-enabled')).to.equal(false);
  });

  test('exposes default labels', () => {
    expect(element.actionText).to.equal('Save / Share');
    expect(element.filenamePrefix).to.equal('webxr-snap');
    expect(element.shareTitle).to.equal('WebXR Snap');
  });

  test('blocks beforexrselect on the shutter', async () => {
    await element.updateComplete;
    const shutter =
        element.shadowRoot!.querySelector('.shutter') as HTMLElement;
    expect(shutter).to.exist;
    const event = new Event(
        'beforexrselect', {bubbles: true, cancelable: true, composed: true});
    shutter.dispatchEvent(event);
    expect(event.defaultPrevented).to.equal(true);
  });

  test('blocks beforexrselect on the preview', async () => {
    await element.updateComplete;
    const preview =
        element.shadowRoot!.querySelector('.preview') as HTMLElement;
    expect(preview).to.exist;
    const event = new Event(
        'beforexrselect', {bubbles: true, cancelable: true, composed: true});
    preview.dispatchEvent(event);
    expect(event.defaultPrevented).to.equal(true);
  });

  suite('save-hint (long-press save mode)', () => {
    test('renders the action button and no backdrop by default', async () => {
      await element.updateComplete;
      const root = element.shadowRoot!;
      expect(element.saveHint).to.equal('');
      expect(root.querySelector('.action-button')).to.exist;
      expect(root.querySelector('.save-hint')).to.equal(null);
      expect(root.querySelector('.preview-backdrop')).to.equal(null);
    });

    test('replaces the action button with the hint and adds a backdrop',
         async () => {
           element.setAttribute('save-hint', 'Long-press to save');
           await element.updateComplete;
           const root = element.shadowRoot!;
           expect(root.querySelector('.action-button')).to.equal(null);
           expect(root.querySelector('.save-hint-text')!.textContent)
               .to.equal('Long-press to save');
           expect(root.querySelector('.preview-backdrop')).to.exist;
           // The close button stays as the only way out of the preview.
           expect(root.querySelector('.preview-close')).to.exist;
         });
  });

  suite('captureWebXRScreenshot', () => {
    test('canCaptureWebXRScreenshot is false before any AR session', () => {
      expect(element.canCaptureWebXRScreenshot).to.equal(false);
    });

    test('resolves with null when no AR session is active', async () => {
      const blob = await element.captureWebXRScreenshot();
      expect(blob).to.equal(null);
    });

    test(
        'dispatches ar-screenshot event with success=false when unavailable',
        async () => {
          const eventPromise = new Promise<CustomEvent>((resolve) => {
            element.addEventListener(
                'ar-screenshot',
                (event) => resolve(event as CustomEvent),
                {once: true});
          });
          const blob = await element.captureWebXRScreenshot();

          const event = await eventPromise;
          expect(event.detail.blob).to.equal(blob);
          expect(event.detail.success).to.equal(false);
        });
  });
});

suite('host-bridge integration with <model-viewer>', () => {
  let host: HTMLElement;
  let plugin: ModelViewerWebXRCapture;

  setup(async () => {
    await import('@google/model-viewer');
    await customElements.whenDefined('model-viewer');
    host = document.createElement('model-viewer');
    document.body.appendChild(host);
    plugin = document.createElement('model-viewer-webxr-capture') as
        ModelViewerWebXRCapture;
    host.appendChild(plugin);
    await (plugin as unknown as {
      updateComplete: Promise<unknown>
    }).updateComplete;
  });

  teardown(() => {
    plugin.remove();
    host.remove();
  });

  test('resolves $scene and $renderer symbols on the host', () => {
    expect(findSymbol(host, 'scene')).to.not.equal(null);
    expect(findSymbol(host, 'renderer')).to.not.equal(null);
  });

  test('records exactly one frame subscriber while connected', () => {
    expect(_getSubscriberCount()).to.equal(1);
  });

  test('unsubscribes the frame listener on disconnect', () => {
    const before = _getSubscriberCount();
    plugin.remove();
    const after = _getSubscriberCount();
    expect(after).to.equal(before - 1);
    // Re-attach so teardown's `plugin.remove()` is a no-op.
    host.appendChild(plugin);
  });

  test('two plugin instances on the same host yield two subscribers', () => {
    const second = document.createElement('model-viewer-webxr-capture') as
        ModelViewerWebXRCapture;
    host.appendChild(second);
    try {
      expect(_getSubscriberCount()).to.equal(2);
    } finally {
      second.remove();
    }
  });

  test('navigator.xr.requestSession wrapper is installed at most once', () => {
    const xr = (navigator as unknown as {xr?: {[k: string]: unknown}}).xr;
    if (xr == null) {
      // Desktop / iOS Safari — wrapper cannot be installed. Confirm that
      // the plugin connected without throwing despite the missing API.
      expect(plugin.canCaptureWebXRScreenshot).to.equal(false);
      return;
    }
    const wrapped = xr['__captureXRRequestSessionWrapped'];
    expect(wrapped).to.equal(true);

    const second = document.createElement('model-viewer-webxr-capture') as
        ModelViewerWebXRCapture;
    host.appendChild(second);
    try {
      expect(xr['__captureXRRequestSessionWrapped']).to.equal(true);
    } finally {
      second.remove();
    }
  });

  test('arRenderer.onWebXRFrame wrapper carries an idempotency marker', () => {
    const rendererSym = findSymbol(host, 'renderer');
    expect(rendererSym).to.not.equal(null);
    const renderer =
        (host as unknown as
         Record<symbol, {arRenderer: unknown}>)[rendererSym!];
    const ar = renderer.arRenderer as {onWebXRFrame: {[k: string]: unknown}};
    expect(ar.onWebXRFrame['__captureOnWebXRFrameWrapped']).to.equal(true);
  });
});
