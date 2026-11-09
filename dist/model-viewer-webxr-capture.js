import { html, css, LitElement } from 'lit';
import { property, query, customElement } from 'lit/decorators.js';
import { ShaderMaterial, Mesh, PlaneGeometry, WebGLRenderTarget, SRGBColorSpace } from 'three';

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
// Background quad rendered behind the 3D scene during capture. The quad is
// drawn with renderOrder = -999 and depthTest/depthWrite disabled, so the
// model always composites on top of it.
//
// The camera texture is already sRGB-encoded and the capture target stores
// sRGB values as-is (no hardware encode), so the fragment passes texels
// through untouched.
const CAMERA_QUAD_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;
const CAMERA_QUAD_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D cameraTex;
  varying vec2 vUv;

  void main() {
    gl_FragColor = texture2D(cameraTex, vUv);
  }
`;

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
/**
 * Implements WebXR AR screenshot capture by composing the raw camera image
 * with the rendered 3D scene into a single Blob.
 *
 *  - Reads the raw camera frame from three.js via
 *    `renderer.xr.getCameraTexture(view.camera)`; the WebXRManager owns the
 *    `XRWebGLBinding` and refreshes the texture once per XR frame when the
 *    session has `camera-access` enabled.
 *  - Adds the background quad as a scene member with renderOrder=-999
 *    and toggles renderer.xr.enabled = false during the offscreen render.
 */
class WebXRCapture {
    constructor(threeRenderer) {
        this.threeRenderer = threeRenderer;
        this.bgQuad = null;
        this.renderTarget = null;
        this.pendingCapture = null;
        this.bgQuad = this.createBackgroundQuad();
    }
    /**
     * Schedule a capture for the next XRFrame. Rejects if a capture is already
     * pending.
     */
    requestCapture(options = {}) {
        if (this.pendingCapture != null) {
            return Promise.reject(new Error('AR capture is already in progress'));
        }
        return new Promise((resolve, reject) => {
            this.pendingCapture = { resolve, reject, options };
        });
    }
    /**
     * Called from the AR session's per-frame hook. Executes any pending
     * capture using the current XRView and the live ArrayCamera.
     */
    processFrame(view, modelScene, viewCamera) {
        const pending = this.pendingCapture;
        if (pending == null) {
            return;
        }
        this.pendingCapture = null;
        try {
            this.executeCapture(view, modelScene, viewCamera, pending);
        }
        catch (error) {
            console.error('[WebXRCapture] executeCapture threw:', error);
            pending.reject(error);
        }
    }
    /** Release GPU resources. Safe to call after dispose(). */
    dispose() {
        if (this.renderTarget != null) {
            this.renderTarget.dispose();
            this.renderTarget = null;
        }
        if (this.bgQuad != null) {
            this.bgQuad.geometry.dispose();
            this.bgQuad.material.dispose();
            this.bgQuad = null;
        }
        if (this.pendingCapture != null) {
            this.pendingCapture.resolve(null);
            this.pendingCapture = null;
        }
    }
    createBackgroundQuad() {
        const material = new ShaderMaterial({
            uniforms: { cameraTex: { value: null } },
            vertexShader: CAMERA_QUAD_VERTEX_SHADER,
            fragmentShader: CAMERA_QUAD_FRAGMENT_SHADER,
            depthTest: false,
            depthWrite: false,
        });
        const mesh = new Mesh(new PlaneGeometry(2, 2), material);
        mesh.frustumCulled = false;
        mesh.renderOrder = -999;
        return mesh;
    }
    executeCapture(view, modelScene, viewCamera, pending) {
        var _a, _b;
        const renderer = this.threeRenderer;
        const rawCamera = view.camera;
        if (rawCamera == null) {
            console.warn('[WebXRCapture] view.camera unavailable; session may not have ' +
                'camera-access enabled.');
            pending.resolve(null);
            return;
        }
        const cameraTexture = renderer.xr.getCameraTexture(rawCamera);
        if (cameraTexture == null) {
            console.warn('[WebXRCapture] No camera texture available for capture.');
            pending.resolve(null);
            return;
        }
        const canvas = renderer.domElement;
        const rtWidth = Math.max(1, Math.floor((_a = pending.options.width) !== null && _a !== void 0 ? _a : canvas.width));
        const rtHeight = Math.max(1, Math.floor((_b = pending.options.height) !== null && _b !== void 0 ? _b : canvas.height));
        this.ensureRenderTarget(rtWidth, rtHeight);
        const renderTarget = this.renderTarget;
        const bgQuad = this.bgQuad;
        bgQuad.material.uniforms.cameraTex.value =
            cameraTexture;
        modelScene.add(bgQuad);
        const prevTarget = renderer.getRenderTarget();
        const wasXrEnabled = renderer.xr.enabled;
        try {
            renderer.xr.enabled = false;
            renderer.setRenderTarget(renderTarget);
            // Force GL write masks on, mirroring upstream Shadow.render().
            renderer.state.buffers.color.setMask(true);
            renderer.state.buffers.depth.setMask(true);
            renderer.render(modelScene, viewCamera);
        }
        finally {
            renderer.xr.enabled = wasXrEnabled;
            renderer.setRenderTarget(prevTarget);
            modelScene.remove(bgQuad);
        }
        const pixels = new Uint8Array(rtWidth * rtHeight * 4);
        renderer.readRenderTargetPixels(renderTarget, 0, 0, rtWidth, rtHeight, pixels);
        this.pixelsToBlob(pixels, rtWidth, rtHeight, pending.options)
            .then((blob) => pending.resolve(blob), (err) => pending.reject(err));
    }
    ensureRenderTarget(width, height) {
        if (this.renderTarget != null) {
            this.renderTarget.setSize(width, height);
            return;
        }
        this.renderTarget = new WebGLRenderTarget(width, height, {
            colorSpace: SRGBColorSpace,
        });
        // Mimic the live XR framebuffer (three.js #23278): renderer.toneMapping
        // and shader-side sRGB encoding apply, while RGBA8 storage avoids a
        // second hardware encode and keeps blending in sRGB space — otherwise
        // the semi-transparent AR floor shadow captures at half strength.
        this.renderTarget
            .isXRRenderTarget = true;
        this.renderTarget.texture.internalFormat = 'RGBA8';
    }
    async pixelsToBlob(pixels, width, height, options) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx == null) {
            return null;
        }
        const imageData = ctx.createImageData(width, height);
        const rowBytes = width * 4;
        for (let y = 0; y < height; y++) {
            const srcOffset = (height - 1 - y) * rowBytes;
            const dstOffset = y * rowBytes;
            imageData.data.set(pixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
        }
        ctx.putImageData(imageData, 0, 0);
        return new Promise((resolve) => {
            var _a, _b;
            canvas.toBlob(resolve, (_a = options.mimeType) !== null && _a !== void 0 ? _a : 'image/jpeg', (_b = options.qualityArgument) !== null && _b !== void 0 ? _b : 0.92);
        });
    }
}

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
/**
 * Owns the `WebXRCapture` lifecycle for a single `<model-viewer-webxr-capture>`
 * instance.
 *
 *  - Constructs `WebXRCapture` when `onSessionStart` is invoked with a session
 *    that has `'camera-access'` enabled.
 *  - Drives `WebXRCapture.processFrame` from the host-bridge frame dispatcher.
 *  - Disposes `WebXRCapture` on session end.
 *
 * The global `'camera-access'` injection that used to live in
 * `beforeRequestSession` is now installed once at plugin connect time by
 * `host-bridge.ts` — see `ensureGlobalPatches`.
 */
class WebXRCaptureProvider {
    constructor() {
        this.capture = null;
        this._supported = false;
    }
    /**
     * True once an AR session has started with `camera-access` enabled. False
     * before session start, after session end, or if the device declines the
     * feature.
     */
    get supported() {
        return this._supported;
    }
    onSessionStart(threeRenderer, session) {
        const sessionAny = session;
        this._supported = sessionAny.enabledFeatures != null &&
            sessionAny.enabledFeatures.indexOf('camera-access') !== -1;
        if (this._supported) {
            this.capture = new WebXRCapture(threeRenderer);
        }
    }
    onFrame(view, scene, viewCamera) {
        if (this.capture == null) {
            return;
        }
        this.capture.processFrame(view, scene, viewCamera);
    }
    onSessionEnd() {
        if (this.capture != null) {
            this.capture.dispose();
            this.capture = null;
        }
        this._supported = false;
    }
    /**
     * Schedules a capture of the current AR view. Resolves with `null` when
     * capture is unavailable (no active session, or `camera-access` not
     * granted).
     */
    requestCapture(options) {
        if (this.capture == null) {
            return Promise.resolve(null);
        }
        return this.capture.requestCapture(options);
    }
}

/* @license
 * Copyright (c) 2026 k1pp0
 * SPDX-License-Identifier: MIT
 *
 * Icon: Lucide "x"
 * Source: https://github.com/lucide-icons/lucide
 * Copyright Lucide Contributors, ISC License
 */
var CaptureCloseIcon = html `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M18 6 6 18"/>
  <path d="m6 6 12 12"/>
</svg>
`;

/* @license
 * Copyright (c) 2026 k1pp0
 * SPDX-License-Identifier: MIT
 *
 * Icon: Lucide "download"
 * Source: https://github.com/lucide-icons/lucide
 * Copyright Lucide Contributors, ISC License
 */
var CaptureDownloadIcon = html `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" x2="12" y1="15" y2="3"/>
</svg>
`;

/* @license
 * Copyright (c) 2026 k1pp0
 * SPDX-License-Identifier: MIT
 *
 * Icon: long-press hand (design asset provided for the save-hint mode)
 */
var CaptureLongPressIcon = html `
<svg width="50" height="50" viewBox="0 0 50 50" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<g clip-path="url(#clip0_4317_897)">
<path d="M35.7829 21.9157C34.3765 20.1121 31.8568 19.6956 29.9599 20.9063C28.7867 19.3425 26.7634 18.7623 24.9779 19.3956V13.2812C24.9779 10.8581 23.0065 8.88672 20.5834 8.88672C18.1602 8.88672 16.1889 10.8581 16.1889 13.2812V23.6818C12.9371 24.3409 10.3403 27.2382 10.358 30.8664L10.3737 34.0957C10.3895 38.4048 12.6326 42.3357 16.2809 44.5447C16.7161 47.6237 19.3688 50 22.566 50H32.8882C36.3883 50 39.2358 47.1524 39.2358 43.6523V43.3185C41.3725 41.2023 42.5855 38.312 42.5855 35.2862V25.5892C42.5854 22.083 38.6735 20.0144 35.7829 21.9157ZM39.6558 35.2862C39.6558 37.6969 38.6166 39.9913 36.8047 41.5813C36.1924 42.1188 36.306 42.7665 36.306 43.6523C36.306 45.537 34.7727 47.0703 32.8881 47.0703H22.5659C20.6812 47.0703 19.1479 45.537 19.1479 43.6523C19.1479 43.1047 18.8424 42.6026 18.3559 42.3512C15.2521 40.7464 13.3162 37.5789 13.3033 34.0832L13.2876 30.8522C13.2781 28.9207 14.5166 27.3091 16.1888 26.7154V32.3242C16.1888 33.1332 16.8446 33.7891 17.6536 33.7891C18.4626 33.7891 19.1184 33.1332 19.1184 32.3242V13.2812C19.1184 12.4735 19.7756 11.8164 20.5833 11.8164C21.391 11.8164 22.0481 12.4735 22.0481 13.2812V24.6169C22.0481 25.4259 22.704 26.0817 23.513 26.0817C24.322 26.0817 24.9778 25.4259 24.9778 24.6169V23.5382C24.9778 22.7305 25.635 22.0733 26.4427 22.0733C27.2504 22.0733 27.9075 22.7305 27.9075 23.5382C27.9075 24.6051 27.9222 24.7841 27.9222 25.5859C27.9222 26.3949 28.578 27.0508 29.387 27.0508C30.196 27.0508 30.8518 26.3949 30.8518 25.5859V24.6125C30.8518 23.8048 31.509 23.1477 32.3167 23.1477C33.1244 23.1477 33.7815 23.8048 33.7815 24.6125C33.7815 26.5495 33.7962 24.9653 33.7962 26.57C33.7962 27.379 34.452 28.0349 35.261 28.0349C36.07 28.0349 36.7259 27.379 36.7259 26.57V25.5893C36.7259 24.7814 37.383 24.1243 38.1907 24.1243C38.9984 24.1243 39.6556 24.7814 39.6556 25.5892V35.2862H39.6558Z" fill="currentColor"/>
<path d="M27.9224 13.2812C27.9224 14.0902 28.5782 14.7461 29.3872 14.7461H32.3169C33.1259 14.7461 33.7817 14.0902 33.7817 13.2812C33.7817 12.4723 33.1259 11.8164 32.3169 11.8164H29.3872C28.5782 11.8164 27.9224 12.4723 27.9224 13.2812Z" fill="currentColor"/>
<path d="M27.8488 8.10225L29.9204 6.03066C30.4924 5.45859 30.4924 4.53115 29.9204 3.95908C29.3484 3.38701 28.4208 3.38701 27.8488 3.95908L25.7772 6.03066C25.2051 6.60273 25.2051 7.53018 25.7772 8.10225C26.3492 8.67432 27.2768 8.67432 27.8488 8.10225Z" fill="currentColor"/>
<path d="M13.3476 8.10225C13.9195 8.67432 14.8472 8.67432 15.4191 8.10225C15.9912 7.53018 15.9912 6.60273 15.4191 6.03066L13.3476 3.95908C12.7756 3.38701 11.848 3.38701 11.276 3.95908C10.7039 4.53115 10.7039 5.45859 11.276 6.03066L13.3476 8.10225Z" fill="currentColor"/>
<path d="M13.2739 13.2812C13.2739 12.4723 12.6181 11.8164 11.8091 11.8164H8.87939C8.07041 11.8164 7.41455 12.4723 7.41455 13.2812C7.41455 14.0902 8.07041 14.7461 8.87939 14.7461H11.8091C12.6181 14.7461 13.2739 14.0902 13.2739 13.2812Z" fill="currentColor"/>
<path d="M20.5981 5.76172C21.4071 5.76172 22.063 5.10586 22.063 4.29688V1.46484C22.063 0.655859 21.4071 0 20.5981 0C19.7892 0 19.1333 0.655859 19.1333 1.46484V4.29688C19.1333 5.10586 19.7892 5.76172 20.5981 5.76172Z" fill="currentColor"/>
</g>
<defs>
<clipPath id="clip0_4317_897">
<rect width="50" height="50" fill="currentColor"/>
</clipPath>
</defs>
</svg>
`;

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
const subscribers = new Set();
const symbolCache = new WeakMap();
let globalPatchesInstalled = false;
let frameHookInstalled = false;
const NAVIGATOR_XR_MARKER = '__captureXRRequestSessionWrapped';
const FRAME_HOOK_MARKER = '__captureOnWebXRFrameWrapped';
/**
 * Walks an object's own properties and prototype chain looking for a symbol
 * whose `.description` matches `description`. Caches results by (proto, desc).
 */
function findSymbol(obj, description) {
    var _a;
    if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
        return null;
    }
    let target = obj;
    while (target != null) {
        let perTarget = symbolCache.get(target);
        if (perTarget == null) {
            perTarget = new Map();
            symbolCache.set(target, perTarget);
        }
        if (perTarget.has(description)) {
            const cached = (_a = perTarget.get(description)) !== null && _a !== void 0 ? _a : null;
            if (cached != null) {
                return cached;
            }
        }
        else {
            const own = Object.getOwnPropertySymbols(target).find((s) => s.description === description);
            perTarget.set(description, own !== null && own !== void 0 ? own : null);
            if (own != null) {
                return own;
            }
        }
        target = Object.getPrototypeOf(target);
    }
    return null;
}
function readSymbolProperty(host, description, name) {
    const sym = findSymbol(host, description);
    if (sym == null) {
        throw new Error(`[model-viewer-webxr-capture] Could not find ${name} on the host ` +
            '<model-viewer>. This usually means @google/model-viewer was ' +
            'upgraded to an incompatible major version. Pin to ^4.3.1 or file ' +
            'an issue at https://github.com/k1pp0/model-viewer-webxr-capture/issues.');
    }
    return host[sym];
}
/**
 * Returns the host element's internal `ModelScene` (a three.js Scene).
 */
function getModelScene(host) {
    return readSymbolProperty(host, 'scene', '$scene');
}
/**
 * Returns the host's internal `Renderer` (the wrapper that owns the
 * `WebGLRenderer` and the singleton `ARRenderer`).
 */
function getRenderer(host) {
    return readSymbolProperty(host, 'renderer', '$renderer');
}
function getThreeRenderer(host) {
    return getRenderer(host).threeRenderer;
}
function getARRenderer(host) {
    return getRenderer(host).arRenderer;
}
/**
 * Returns the live `XRSession` if one is active on the host's renderer,
 * otherwise `null`.
 */
function getXRSession(host) {
    const xr = getThreeRenderer(host).xr;
    return xr.getSession();
}
/**
 * Idempotently installs the `navigator.xr.requestSession` wrapper that appends
 * `'camera-access'` to the `optionalFeatures` of every `'immersive-ar'`
 * session request.
 *
 * This is a global side effect. It is gated on the first plugin connect, so
 * pages that load the bundle but do not use `<model-viewer-webxr-capture>`
 * see no behavior change.
 */
function ensureGlobalPatches() {
    if (globalPatchesInstalled) {
        return;
    }
    globalPatchesInstalled = true;
    const xr = (typeof navigator !== 'undefined' ? navigator.xr : null);
    if (xr != null && xr[NAVIGATOR_XR_MARKER] !== true &&
        typeof xr.requestSession === 'function') {
        const original = xr.requestSession.bind(xr);
        xr.requestSession = function (mode, options) {
            if (mode === 'immersive-ar') {
                const opts = options !== null && options !== void 0 ? options : {};
                const optional = Array.isArray(opts.optionalFeatures) ?
                    opts.optionalFeatures.slice() :
                    [];
                if (optional.indexOf('camera-access') === -1) {
                    optional.push('camera-access');
                }
                return original(mode, Object.assign(Object.assign({}, opts), { optionalFeatures: optional }));
            }
            return original(mode, options);
        };
        xr[NAVIGATOR_XR_MARKER] = true;
    }
}
/**
 * Idempotently wraps `arRenderer.onWebXRFrame` so that, after the original
 * frame logic runs, every subscriber whose host's scene equals the current
 * `presentedScene` is invoked with `(firstView, scene, viewCamera)`.
 *
 * `arRenderer` is a process-wide singleton (`Renderer.singleton.arRenderer`),
 * so the wrapper is installed exactly once for the entire page.
 */
function ensureFrameHook(host) {
    if (frameHookInstalled) {
        return;
    }
    const arRenderer = getARRenderer(host);
    if (arRenderer.onWebXRFrame[FRAME_HOOK_MARKER] === true) {
        frameHookInstalled = true;
        return;
    }
    const original = arRenderer.onWebXRFrame.bind(arRenderer);
    const wrapped = function (time, frame) {
        original(time, frame);
        dispatchFrame(arRenderer);
    };
    wrapped[FRAME_HOOK_MARKER] = true;
    arRenderer.onWebXRFrame = wrapped;
    frameHookInstalled = true;
}
function dispatchFrame(arRenderer) {
    if (subscribers.size === 0) {
        return;
    }
    const scene = arRenderer.presentedScene;
    if (scene == null) {
        return;
    }
    const frame = arRenderer.frame;
    if (frame == null) {
        return;
    }
    const xr = arRenderer.threeRenderer.xr;
    const refSpace = xr.getReferenceSpace();
    if (refSpace == null) {
        return;
    }
    const pose = frame.getViewerPose(refSpace);
    if (pose == null || pose.views.length === 0) {
        return;
    }
    const view = pose.views[0];
    const xrCamera = xr.getCamera();
    const cameras = xrCamera.cameras;
    const viewCamera = cameras != null && cameras.length > 0 ? cameras[0] : xrCamera;
    for (const sub of subscribers) {
        let hostScene = null;
        try {
            hostScene = getModelScene(sub.host);
        }
        catch (_a) {
            continue;
        }
        if (hostScene === scene) {
            try {
                sub.callback(view, scene, viewCamera);
            }
            catch (e) {
                console.warn('[model-viewer-webxr-capture] frame subscriber threw:', e);
            }
        }
    }
}
/**
 * Subscribes a callback that fires once per AR frame for the matching host
 * (i.e. when `arRenderer.presentedScene === host[$scene]`). Returns an
 * unsubscribe function. Safe to call multiple times for the same host.
 */
function subscribe(host, callback) {
    const entry = { host, callback };
    subscribers.add(entry);
    return () => {
        subscribers.delete(entry);
    };
}

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
// Layout/visuals developed with reference to 8thwall xrextras mediarecorder
// (record-button.css / media-preview.css). Theming is exposed via CSS
// custom properties on the host.
const captureUIStyles = css `
:host {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: block;
  z-index: 20;
}

.style-reset {
  background: none;
  border: none;
  outline: none;
  box-shadow: none !important;
  padding: 0;
  margin: 0;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  font-family: inherit;
}
.style-reset:focus { outline: 0; }

/* --- Shutter --- */
.shutter {
  position: absolute;
  width: 25vmin;
  height: 25vmin;
  max-width: 10em;
  max-height: 10em;
  bottom: 3vmin;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: auto;
  touch-action: none;
  opacity: 1;
  transition: 0.5s opacity;
  display: none;
}
:host(.shutter-enabled) .shutter {
  display: block;
}
.shutter.fade-container {
  opacity: 0;
  pointer-events: none;
}
.shutter .recorder-button {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: var(--webxr-capture-button-color, #fff);
  border-radius: 50%;
  color: transparent;
  transform-origin: 50% 50%;
  transform: scale(0.6);
  transition: 0.3s border-radius, 0.3s transform;
}
.shutter .recorder-button:active {
  transform: scale(0.5);
}
.shutter .progress-container {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  transform: scale(0.9);
}
.shutter .progress-track {
  fill: transparent;
  stroke: var(--webxr-capture-ring-color, #fff);
  stroke-width: 3;
}

/* --- Flash --- */
.flash {
  position: absolute;
  inset: 0;
  background: #fff;
  opacity: 0;
  pointer-events: none;
  transition: 0.6s opacity;
  z-index: 40;
}
.flash.flashing {
  transition: 0s opacity;
  opacity: 1;
  z-index: 100;
}

/* --- Preview --- */
.preview {
  display: none;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  position: absolute;
  inset: 0;
  z-index: 30;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  box-sizing: border-box;
  font-family: var(--webxr-capture-font-family, inherit);
}
:host(.preview-open) .preview {
  display: flex;
}
.preview.fade-in {
  transition: 0.5s opacity;
  opacity: 1;
  pointer-events: auto;
}
.preview .top-bar {
  position: relative;
  flex: 1 0 0;
}
.preview .preview-box {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
.preview .preview-image {
  display: block;
  max-width: 90vw;
  max-height: calc(88vh - 12vmin);
  border-radius: 10px;
  border: 1vmin solid var(--webxr-capture-image-border-color, #fff);
  background-color: #fff;
  filter: drop-shadow(0 0 2px #333);
}
.preview .icon-button {
  padding: 4vmin;
}
.preview .icon-button > svg {
  display: block;
  height: 7.5vmin;
  width: 7.5vmin;
  filter: drop-shadow(0 0 2px #333);
}
.preview .preview-close {
  position: absolute;
  top: 0;
  right: 0;
  z-index: 1;
}
.preview .bottom-bar {
  display: flex;
  justify-content: center;
  position: relative;
  margin: 0 5vmin 5vmin 5vmin;
}
.preview .action-button {
  padding: 0.3em 0.5em;
  font-family: inherit;
  text-align: right;
  color: var(--webxr-capture-action-button-text-color, #000);
  background-color: var(--webxr-capture-action-button-color, #fff);
  border-radius: 0.5em;
  font-size: 5vmin;
  min-width: 3.25em;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  text-decoration: none;
}
.preview .action-button:active {
  filter: brightness(0.85);
}
.preview .action-button > svg {
  height: 0.8em;
  width: 0.8em;
  margin-left: 0.4em;
}

/* --- Long-press save mode (save-hint attribute) --- */
/* Darkened, blurred copy of the snapshot behind the preview. Extends past the
   edges by more than the blur radius so the blurred border never shows. */
.preview .preview-backdrop {
  position: absolute;
  inset: -48px;
  width: calc(100% + 96px);
  height: calc(100% + 96px);
  object-fit: cover;
  background-color: #000;
  filter: var(--webxr-capture-backdrop-filter, blur(16px) brightness(0.45));
  pointer-events: none;
  z-index: -1;
}
.preview .save-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--webxr-capture-save-hint-color, #fff);
  font-size: 16px;
  font-weight: 700;
  -webkit-user-select: none;
  user-select: none;
  /* Keep clear of the iPhone home indicator. */
  margin-bottom: max(0px, env(safe-area-inset-bottom));
}
.preview .save-hint > svg {
  height: 50px;
  width: 50px;
  flex: none;
}
`;

/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */
var __decorate = (undefined && undefined.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
const PREVIEW_FADE_MS = 500;
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
let ModelViewerWebXRCapture = class ModelViewerWebXRCapture extends LitElement {
    constructor() {
        super(...arguments);
        this.actionText = 'Save / Share';
        this.filenamePrefix = 'webxr-snap';
        this.shareTitle = 'WebXR Snap';
        /**
         * When set (non-empty), the preview switches to "long-press to save" mode:
         * the save / share action button is replaced with this hint text, and a
         * darkened, blurred copy of the snapshot is laid behind the preview so the
         * hint stays legible. Saving is left to the browser's long-press menu on
         * the preview image.
         */
        this.saveHint = '';
        this.host = null;
        this.provider = new WebXRCaptureProvider();
        this.unsubscribeFrame = null;
        this.sessionActive = false;
        this.currentBlob = null;
        this.currentUrl = null;
        this.clearSrcTimer = 0;
        this.onFrameTick = (view, scene, viewCamera) => {
            this.provider.onFrame(view, scene, viewCamera);
        };
        this.onARStatus = (event) => {
            const status = event.detail.status;
            if (status === 'session-started') {
                if (this.host != null) {
                    try {
                        const threeRenderer = getThreeRenderer(this.host);
                        const session = getXRSession(this.host);
                        if (session != null) {
                            this.provider.onSessionStart(threeRenderer, session);
                            this.sessionActive = true;
                        }
                    }
                    catch (err) {
                        console.warn('[model-viewer-webxr-capture] could not initialize capture for ' +
                            'session-started:', err);
                    }
                }
                this.updateShutterVisibility();
            }
            else if (status === 'not-presenting' || status === 'failed') {
                if (this.sessionActive) {
                    this.provider.onSessionEnd();
                    this.sessionActive = false;
                }
                this.classList.remove('shutter-enabled');
                this.hidePreview();
            }
        };
        this.onBeforeXRSelect = (event) => {
            event.preventDefault();
        };
        this.onShutterClick = () => {
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
                .catch((err) => {
                console.warn('[model-viewer-webxr-capture] capture failed:', err);
            });
        };
        this.hidePreview = () => {
            var _a, _b;
            if (!this.classList.contains('preview-open')) {
                return;
            }
            (_a = this.previewEl) === null || _a === void 0 ? void 0 : _a.classList.remove('fade-in');
            // Bring the shutter back via the same fade transition.
            (_b = this.shutterEl) === null || _b === void 0 ? void 0 : _b.classList.remove('fade-container');
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
                var _a;
                if (this.previewImg != null) {
                    this.previewImg.removeAttribute('src');
                }
                (_a = this.previewBackdrop) === null || _a === void 0 ? void 0 : _a.removeAttribute('src');
                this.classList.remove('preview-open');
                this.releaseCurrentBlob();
                this.clearSrcTimer = 0;
            }, PREVIEW_FADE_MS);
            this.dispatchEvent(new CustomEvent('webxr-capture-preview-closed'));
        };
        this.onActionClick = async () => {
            var _a;
            const blob = this.currentBlob;
            const url = this.currentUrl;
            if (blob == null || url == null) {
                return;
            }
            const filename = `${this.filenamePrefix}-${Date.now()}.jpg`;
            const file = new File([blob], filename, { type: blob.type });
            const nav = navigator;
            if ((_a = nav.canShare) === null || _a === void 0 ? void 0 : _a.call(nav, { files: [file] })) {
                try {
                    await nav.share({ files: [file], title: this.shareTitle });
                    return;
                }
                catch (err) {
                    if (err != null && err.name === 'AbortError') {
                        return;
                    }
                    console.warn('[model-viewer-webxr-capture] share failed, falling back to download:', err);
                }
            }
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
        };
    }
    /**
     * True when the active WebXR AR session has the `camera-access` feature
     * enabled. False before the session starts, after it ends, or when no
     * session is active.
     */
    get canCaptureWebXRScreenshot() {
        return this.provider.supported;
    }
    /**
     * Captures the current WebXR AR view (camera passthrough composed with the
     * rendered 3D scene) as a Blob. Resolves with `null` when capture is
     * unavailable. Also dispatches an `ar-screenshot` event with the result.
     */
    async captureWebXRScreenshot(options) {
        const blob = await this.provider.requestCapture(options);
        this.dispatchEvent(new CustomEvent('ar-screenshot', { detail: { blob, success: blob !== null } }));
        return blob;
    }
    connectedCallback() {
        super.connectedCallback();
        // Suppress WebXR transient-input select for taps that hit our overlay UI,
        // per the WebXR DOM Overlays spec — otherwise a shutter / preview tap also
        // re-places or drags the AR model.
        this.addEventListener('beforexrselect', this.onBeforeXRSelect);
        this.resolveHost();
    }
    disconnectedCallback() {
        super.disconnectedCallback();
        this.removeEventListener('beforexrselect', this.onBeforeXRSelect);
        this.detachHost();
        this.releaseCurrentBlob();
    }
    updated(changed) {
        if (changed.has('for')) {
            this.detachHost();
            this.resolveHost();
        }
    }
    render() {
        const longPressMode = this.saveHint.length > 0;
        return html `
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
            html `<img class="preview-backdrop" alt="" aria-hidden="true">` :
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
            html `<div class="save-hint">
                <span class="save-hint-text">${this.saveHint}</span>
                ${CaptureLongPressIcon}
              </div>` :
            html `<button class="action-button style-reset" type="button"
                  @click=${this.onActionClick}>
                <span class="action-text">${this.actionText}</span>
                ${CaptureDownloadIcon}
              </button>`}
        </div>
      </div>
    `;
    }
    resolveHost() {
        var _a;
        const root = this.getRootNode();
        const host = (this.for != null && this.for.length > 0) ?
            (_a = root.getElementById) === null || _a === void 0 ? void 0 : _a.call(root, this.for) :
            this.closest('model-viewer');
        if (host == null) {
            return;
        }
        this.host = host;
        try {
            ensureGlobalPatches();
            ensureFrameHook(host);
            this.unsubscribeFrame = subscribe(host, this.onFrameTick);
        }
        catch (err) {
            console.warn('[model-viewer-webxr-capture] failed to attach to <model-viewer>:', err);
            this.host = null;
            return;
        }
        host.addEventListener('ar-status', this.onARStatus);
        // Plugin attached after AR is already running cannot retroactively
        // request `'camera-access'` for the live session — capture will be
        // available only on the next AR session.
        try {
            if (getARRenderer(host).isPresenting) {
                console.warn('[model-viewer-webxr-capture] attached while AR session is active; ' +
                    'capture will be available on the next AR session.');
            }
        }
        catch (_b) {
            // Symbol resolution already validated above; this is a safety net.
        }
    }
    detachHost() {
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
    updateShutterVisibility() {
        if (this.canCaptureWebXRScreenshot) {
            this.classList.add('shutter-enabled');
        }
        else {
            this.classList.remove('shutter-enabled');
        }
    }
    showPreview(blob) {
        var _a, _b;
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
        (_a = this.previewEl) === null || _a === void 0 ? void 0 : _a.classList.add('fade-in');
        // Hide the shutter behind the preview during the fade-in.
        (_b = this.shutterEl) === null || _b === void 0 ? void 0 : _b.classList.add('fade-container');
        this.dispatchEvent(new CustomEvent('webxr-capture-preview-opened', { detail: { blob } }));
    }
    releaseCurrentBlob() {
        if (this.currentUrl != null) {
            URL.revokeObjectURL(this.currentUrl);
        }
        this.currentUrl = null;
        this.currentBlob = null;
    }
};
ModelViewerWebXRCapture.styles = captureUIStyles;
__decorate([
    property({ type: String })
], ModelViewerWebXRCapture.prototype, "for", void 0);
__decorate([
    property({ type: String, attribute: 'action-text' })
], ModelViewerWebXRCapture.prototype, "actionText", void 0);
__decorate([
    property({ type: String, attribute: 'filename-prefix' })
], ModelViewerWebXRCapture.prototype, "filenamePrefix", void 0);
__decorate([
    property({ type: String, attribute: 'share-title' })
], ModelViewerWebXRCapture.prototype, "shareTitle", void 0);
__decorate([
    property({ type: String, attribute: 'save-hint', reflect: true })
], ModelViewerWebXRCapture.prototype, "saveHint", void 0);
__decorate([
    query('.flash')
], ModelViewerWebXRCapture.prototype, "flashEl", void 0);
__decorate([
    query('.shutter')
], ModelViewerWebXRCapture.prototype, "shutterEl", void 0);
__decorate([
    query('.preview')
], ModelViewerWebXRCapture.prototype, "previewEl", void 0);
__decorate([
    query('.preview-image')
], ModelViewerWebXRCapture.prototype, "previewImg", void 0);
__decorate([
    query('.preview-backdrop')
], ModelViewerWebXRCapture.prototype, "previewBackdrop", void 0);
ModelViewerWebXRCapture = __decorate([
    customElement('model-viewer-webxr-capture')
], ModelViewerWebXRCapture);

export { ModelViewerWebXRCapture };
//# sourceMappingURL=model-viewer-webxr-capture.js.map
