/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

import type { Camera, Scene } from 'three';

import { html, LitElement, PropertyValues, TemplateResult } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

import { WebXRCaptureProvider } from './webxr-capture-provider.js';
import CaptureCloseIcon from './assets/capture-close-svg.js';
import CaptureDownloadIcon from './assets/capture-download-svg.js';
import CaptureLongPressIcon from './assets/capture-long-press-svg.js';
import { ensureFrameHook, ensureGlobalPatches, getARRenderer, getThreeRenderer, getXRSession, subscribe } from './host-bridge.js';
import { captureUIStyles } from './styles/capture-ui.css.js';
import { WebXRCaptureOptions } from './three-components/WebXRCapture.js';

const PREVIEW_FADE_MS = 500;

interface ARStatusEventDetail {
  status: 'not-presenting' | 'session-started' | 'object-placed' | 'failed';
}

export interface WebXRScreenshotDetails {
  blob: Blob | null;
  success: boolean;
}

/**
 * Companion element that adds WebXR AR screenshot capture, plus a built-in
 * shutter / flash / preview UI, on top of `<model-viewer>`. All capture
 * implementation lives in this package — installing it is what enables the
 * feature; removing it leaves `<model-viewer>` capture-free.
 *
 * Usage:
 *
 *   <model-viewer id="mv" src="…" ar>
 *     <model-viewer-webxr-capture></model-viewer-webxr-capture>
 *   </model-viewer>
 *
 * The `for` attribute resolves to a sibling `<model-viewer>` by id. If
 * omitted, the closest ancestor `<model-viewer>` is used.
 */
@customElement('model-viewer-webxr-capture')
export class ModelViewerWebXRCapture extends LitElement {
  static styles = captureUIStyles;

  /** ID of the host `<model-viewer>` element. */
  @property({ type: String }) for?: string;

  @property({ type: String, attribute: 'action-text' })
  actionText = 'Save / Share';

  @property({ type: String, attribute: 'filename-prefix' })
  filenamePrefix = 'webxr-snap';

  @property({ type: String, attribute: 'share-title' }) shareTitle = 'WebXR Snap';

  /**
   * When set (non-empty), the preview switches to "long-press to save" mode:
   * the save / share action button is replaced with this hint text, and a
   * darkened, blurred copy of the snapshot is laid behind the preview so the
   * hint stays legible. Saving is left to the browser's long-press menu on
   * the preview image.
   */
  @property({ type: String, attribute: 'save-hint', reflect: true })
  saveHint = '';

  @query('.flash') private flashEl!: HTMLElement;
  @query('.shutter') private shutterEl!: HTMLElement;
  @query('.preview') private previewEl!: HTMLElement;
  @query('.preview-image') private previewImg!: HTMLImageElement;
  @query('.preview-backdrop') private previewBackdrop!: HTMLImageElement | null;

  private host: HTMLElement | null = null;
  private provider = new WebXRCaptureProvider();
  private unsubscribeFrame: (() => void) | null = null;
  private sessionActive = false;
  private currentBlob: Blob | null = null;
  private currentUrl: string | null = null;
  private clearSrcTimer = 0;

  /**
   * True when the active WebXR AR session has the `camera-access` feature
   * enabled. False before the session starts, after it ends, or when no
   * session is active.
   */
  get canCaptureWebXRScreenshot(): boolean {
    return this.provider.supported;
  }

  /**
   * Captures the current WebXR AR view (camera passthrough composed with the
   * rendered 3D scene) as a Blob. Resolves with `null` when capture is
   * unavailable. Also dispatches an `ar-screenshot` event with the result.
   */
  async captureWebXRScreenshot(options?: WebXRCaptureOptions):
    Promise<Blob | null> {
    const blob = await this.provider.requestCapture(options);

    this.dispatchEvent(new CustomEvent<WebXRScreenshotDetails>(
      'ar-screenshot', { detail: { blob, success: blob !== null } }));

    return blob;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Suppress WebXR transient-input select for taps that hit our overlay UI,
    // per the WebXR DOM Overlays spec — otherwise a shutter / preview tap also
    // re-places or drags the AR model.
    this.addEventListener('beforexrselect', this.onBeforeXRSelect);
    this.resolveHost();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('beforexrselect', this.onBeforeXRSelect);
    this.detachHost();
    this.releaseCurrentBlob();
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has('for')) {
      this.detachHost();
      this.resolveHost();
    }
  }

  protected render(): TemplateResult {
    const longPressMode = this.saveHint.length > 0;
    return html`
      <div class="flash" aria-hidden="true"></div>
      <div class="shutter" part="shutter">
        <svg class="progress-container" viewBox="0 0 38 38" aria-hidden="true">
          <circle class="progress-track" cx="19" cy="19" r="16"></circle>
        </svg>
        <button class="recorder-button style-reset" type="button"
            aria-label="Capture AR snapshot"
            @click=${this.onShutterClick}></button>
      </div>
      <div class="preview" part="preview" role="dialog"
          aria-label="AR snapshot preview">
        ${longPressMode ?
        html`<img class="preview-backdrop" alt="" aria-hidden="true">` :
        null}
        <div class="top-bar">
          <div class="preview-box">
            <button class="preview-close style-reset icon-button" type="button"
                aria-label="Close preview" @click=${this.hidePreview}>
              ${CaptureCloseIcon}
            </button>
            <img class="preview-image" alt="AR snapshot preview">
          </div>
        </div>
        <div class="bottom-bar">
          ${longPressMode ?
        html`<div class="save-hint">
                <span class="save-hint-text">${this.saveHint}</span>
                ${CaptureLongPressIcon}
              </div>` :
        html`<button class="action-button style-reset" type="button"
                  @click=${this.onActionClick}>
                <span class="action-text">${this.actionText}</span>
                ${CaptureDownloadIcon}
              </button>`}
        </div>
      </div>
    `;
  }

  private resolveHost(): void {
    const root = this.getRootNode() as Document | ShadowRoot;
    const host = (this.for != null && this.for.length > 0) ?
      (root.getElementById?.(this.for) as HTMLElement | null) :
      (this.closest('model-viewer') as HTMLElement | null);
    if (host == null) {
      return;
    }
    this.host = host;

    try {
      ensureGlobalPatches();
      ensureFrameHook(host);
      this.unsubscribeFrame = subscribe(host, this.onFrameTick);
    } catch (err) {
      console.warn(
        '[model-viewer-webxr-capture] failed to attach to <model-viewer>:',
        err);
      this.host = null;
      return;
    }

    host.addEventListener('ar-status', this.onARStatus);

    // Plugin attached after AR is already running cannot retroactively
    // request `'camera-access'` for the live session — capture will be
    // available only on the next AR session.
    try {
      if (getARRenderer(host).isPresenting) {
        console.warn(
          '[model-viewer-webxr-capture] attached while AR session is active; ' +
          'capture will be available on the next AR session.');
      }
    } catch {
      // Symbol resolution already validated above; this is a safety net.
    }
  }

  private detachHost(): void {
    if (this.host == null) {
      return;
    }
    this.host.removeEventListener('ar-status', this.onARStatus);
    if (this.unsubscribeFrame != null) {
      this.unsubscribeFrame();
      this.unsubscribeFrame = null;
    }
    if (this.sessionActive) {
      this.provider.onSessionEnd();
      this.sessionActive = false;
    }
    this.host = null;
  }

  private onFrameTick =
    (view: XRView, scene: Scene, viewCamera: Camera): void => {
      this.provider.onFrame(view, scene, viewCamera);
    };

  private onARStatus = (event: Event) => {
    const status = (event as CustomEvent<ARStatusEventDetail>).detail.status;
    if (status === 'session-started') {
      if (this.host != null) {
        try {
          const threeRenderer = getThreeRenderer(this.host);
          const session = getXRSession(this.host);
          if (session != null) {
            this.provider.onSessionStart(threeRenderer, session);
            this.sessionActive = true;
          }
        } catch (err) {
          console.warn(
            '[model-viewer-webxr-capture] could not initialize capture for ' +
            'session-started:',
            err);
        }
      }
      this.updateShutterVisibility();
    } else if (status === 'not-presenting' || status === 'failed') {
      if (this.sessionActive) {
        this.provider.onSessionEnd();
        this.sessionActive = false;
      }
      this.classList.remove('shutter-enabled');
      this.hidePreview();
    }
  };

  private updateShutterVisibility(): void {
    if (this.canCaptureWebXRScreenshot) {
      this.classList.add('shutter-enabled');
    } else {
      this.classList.remove('shutter-enabled');
    }
  }

  private onBeforeXRSelect = (event: Event): void => {
    event.preventDefault();
  };

  private onShutterClick = (): void => {
    const flash = this.flashEl;
    if (flash != null) {
      // Match 8thwall: instant white (.flashing has 0s transition), then
      // fade back via the default 0.6s opacity transition.
      flash.classList.add('flashing');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => flash.classList.remove('flashing'));
      });
    }
    this.captureWebXRScreenshot()
      .then((blob) => {
        if (blob != null) {
          this.showPreview(blob);
        }
      })
      .catch((err: Error) => {
        console.warn('[model-viewer-webxr-capture] capture failed:', err);
      });
  };

  private showPreview(blob: Blob): void {
    this.releaseCurrentBlob();
    this.currentBlob = blob;
    this.currentUrl = URL.createObjectURL(blob);

    if (this.previewImg != null) {
      this.previewImg.style.visibility = '';
      this.previewImg.src = this.currentUrl;
    }
    if (this.previewBackdrop != null) {
      this.previewBackdrop.style.visibility = '';
      this.previewBackdrop.src = this.currentUrl;
    }
    this.classList.add('preview-open');
    this.previewEl?.classList.add('fade-in');
    // Hide the shutter behind the preview during the fade-in.
    this.shutterEl?.classList.add('fade-container');
    this.dispatchEvent(
      new CustomEvent('webxr-capture-preview-opened', { detail: { blob } }));
  }

  private hidePreview = (): void => {
    if (!this.classList.contains('preview-open')) {
      return;
    }
    this.previewEl?.classList.remove('fade-in');
    // Bring the shutter back via the same fade transition.
    this.shutterEl?.classList.remove('fade-container');

    // Hide the <img> immediately so the broken-image icon never flashes
    // through the fade-out; clear src after the transition completes.
    if (this.previewImg != null) {
      this.previewImg.style.visibility = 'hidden';
    }
    if (this.previewBackdrop != null) {
      this.previewBackdrop.style.visibility = 'hidden';
    }
    if (this.clearSrcTimer !== 0) {
      clearTimeout(this.clearSrcTimer);
    }
    this.clearSrcTimer = window.setTimeout(() => {
      if (this.previewImg != null) {
        this.previewImg.removeAttribute('src');
      }
      this.previewBackdrop?.removeAttribute('src');
      this.classList.remove('preview-open');
      this.releaseCurrentBlob();
      this.clearSrcTimer = 0;
    }, PREVIEW_FADE_MS);

    this.dispatchEvent(new CustomEvent('webxr-capture-preview-closed'));
  };

  private onActionClick = async (): Promise<void> => {
    const blob = this.currentBlob;
    const url = this.currentUrl;
    if (blob == null || url == null) {
      return;
    }

    const filename = `${this.filenamePrefix}-${Date.now()}.jpg`;
    const file = new File([blob], filename, { type: blob.type });

    const nav =
      navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try {
        await nav.share!({ files: [file], title: this.shareTitle });
        return;
      } catch (err) {
        if (err != null && (err as Error).name === 'AbortError') {
          return;
        }
        console.warn(
          '[model-viewer-webxr-capture] share failed, falling back to download:',
          err);
      }
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  };

  private releaseCurrentBlob(): void {
    if (this.currentUrl != null) {
      URL.revokeObjectURL(this.currentUrl);
    }
    this.currentUrl = null;
    this.currentBlob = null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'model-viewer-webxr-capture': ModelViewerWebXRCapture;
  }
}
