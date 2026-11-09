# `@k1pp0/model-viewer-webxr-capture`

WebXR AR screenshot capture plugin for Google's [`<model-viewer>`](https://github.com/google/model-viewer). Drop `<model-viewer-webxr-capture>` inside any `<model-viewer ar>` element to get a built-in shutter button, flash overlay, and share/download preview — with no modifications to the upstream package.

**Works against the unmodified upstream `@google/model-viewer` from npm.**
This package self-installs the WebXR capture stack at runtime — the host element needs no patches, no fork, and no extra registration call:

- a `WebGLRenderer`-driven `WebXRCapture` that composes the WebXR camera passthrough with the rendered 3D scene into a `Blob`,
- a global `navigator.xr.requestSession` wrapper that injects the WebXR `'camera-access'` optional feature,
- a one-time wrapper around the singleton `ARRenderer.onWebXRFrame` for the per-frame capture pipeline,
- the public element API (`captureWebXRScreenshot()`, `canCaptureWebXRScreenshot`, `ar-screenshot` event) — exposed on the companion element itself, not on the host `<model-viewer>`,
- a familiar AR camera UX (shutter button, fullscreen flash, snapshot preview with save/share).

## Demo

[Live demo on GitHub Pages →](https://k1pp0.github.io/model-viewer-webxr-capture/)

*(Requires a WebXR-capable Android device with Chrome 149+ — the raw camera image is read through three.js' native `renderer.xr.getCameraTexture()` path, which crashes on Chrome 147/148.)*

## Install

The host `<model-viewer>` is the **standard upstream package from npm** — this plugin contains no fork of `@google/model-viewer`.

### CDN / static deployment (no bundler)

The bundled variant inlines three.js and Lit — no import map or build step needed. Load both scripts as ES modules:

```html
<script type="module" src="https://unpkg.com/@google/model-viewer@4.3.1/dist/model-viewer.min.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/gh/k1pp0/model-viewer-webxr-capture@v0.2.1/dist/model-viewer-webxr-capture-bundled.min.js"></script>
```

### npm / bundler

This package is distributed via [GitHub Releases](https://github.com/k1pp0/model-viewer-webxr-capture/releases) as a tarball (`.tgz`), not via the public npm registry. Install it directly from the release URL:

```bash
npm install @google/model-viewer https://github.com/k1pp0/model-viewer-webxr-capture/releases/download/v0.2.1/k1pp0-model-viewer-webxr-capture-0.2.1.tgz
```

`<model-viewer>` is the unmodified upstream package; the plugin attaches itself purely via Symbol reflection on the host element + idempotent global patches at first `connectedCallback`. Pages that load the plugin module without placing `<model-viewer-webxr-capture>` see no behavior change.

The plugin is verified against `@google/model-viewer` 4.3.1 (three.js 0.183.x). It also runs against 4.2.0 / three.js 0.182.x.

## Usage

Nest the companion element inside `<model-viewer>` as a light-DOM child. This is required so the shutter / preview render inside the WebXR `dom-overlay` tree once an AR session goes fullscreen — a sibling element outside `<model-viewer>` would be hidden during the AR session.

```html
<script type="module" src="path/to/model-viewer.js"></script>
<script type="module" src="path/to/model-viewer-webxr-capture.js"></script>

<model-viewer src="…" ar ar-modes="webxr scene-viewer quick-look" camera-controls>
  <model-viewer-webxr-capture action-text="Save / Share" filename-prefix="webxr-snap" share-title="WebXR Snap"></model-viewer-webxr-capture>
</model-viewer>
```

The companion element resolves its host via the closest ancestor `<model-viewer>`. If you must place it outside, use the `for` attribute to target a `<model-viewer>` by id — but note that AR-time visibility is only guaranteed when nested.

On `connectedCallback` the element installs (idempotently and lazily) the global `navigator.xr.requestSession` wrapper and a wrapper around the singleton `ARRenderer.onWebXRFrame`. It then listens to the host's `ar-status` event to drive `WebXRCapture` lifecycle and subscribes to per-frame dispatch from the wrapped `onWebXRFrame`.

If the plugin is attached while an AR session is already running, the session continues without `'camera-access'` and a console warning is emitted — capture becomes available on the next AR session.

The shutter is auto-shown when an AR session starts and `camera-access` was granted (i.e. `cap.canCaptureWebXRScreenshot === true`). On iOS Quick Look / Scene Viewer this element stays hidden.

## Element API

The companion element owns the public capture API; the host `<model-viewer>` intentionally exposes none.

| Member | Description |
|---|---|
| `captureWebXRScreenshot(options?): Promise<Blob\|null>` | Schedule a capture for the next XR frame. Resolves with a `Blob`, or `null` if no session is active or `camera-access` is unavailable. Also dispatches `ar-screenshot`. |
| `canCaptureWebXRScreenshot: boolean` | Read-only. `true` while an AR session is active with `camera-access` granted. |

`captureWebXRScreenshot` accepts an optional options object: `mimeType` (default `'image/jpeg'`), `qualityArgument` (default `0.92`), `width` and `height` (default the WebGL canvas size).

## Attributes

| Attribute | Default | Description |
|---|---|---|
| `for` | _none_ | Optional id of the host `<model-viewer>`. Defaults to closest ancestor. |
| `action-text` | `Save / Share` | Label shown on the preview's action button. |
| `filename-prefix` | `webxr-snap` | Prefix for the downloaded / shared file name. |
| `share-title` | `WebXR Snap` | Title passed to `navigator.share`. |
| `save-hint` | _empty_ | When set, switches the preview to long-press-to-save mode: the action button is replaced with this hint text (followed by a long-press icon), and a darkened, blurred copy of the snapshot is laid behind the preview. Saving relies on the browser's long-press menu on the preview image. |

## Events

All events fire on the `<model-viewer-webxr-capture>` element itself (not on the host `<model-viewer>`).

| Event | Detail | Notes |
|---|---|---|
| `ar-screenshot` | `{ blob: Blob\|null, success: boolean }` | Fires for every `captureWebXRScreenshot()` call (success or not). |
| `webxr-capture-preview-opened` | `{ blob: Blob }` | Fired when the snapshot preview appears. |
| `webxr-capture-preview-closed` | _none_ | Fired when the user dismisses the preview. |

## CSS custom properties

| Property | Default |
|---|---|
| `--webxr-capture-button-color` | `#fff` |
| `--webxr-capture-ring-color` | `#fff` |
| `--webxr-capture-image-border-color` | `#fff` |
| `--webxr-capture-action-button-color` | `#fff` |
| `--webxr-capture-action-button-text-color` | `#000` |
| `--webxr-capture-font-family` | `inherit` |
| `--webxr-capture-save-hint-color` | `#fff` |
| `--webxr-capture-backdrop-filter` | `blur(16px) brightness(0.45)` |

## Acknowledgements

### Google `<model-viewer>`
This plugin is built for and tightly coupled to Google's [`@google/model-viewer`](https://github.com/google/model-viewer) web component. It hooks into model-viewer's WebXR rendering pipeline via internal Symbol reflection to access the Three.js renderer, XR session, and per-frame callbacks — without forking or modifying the upstream package. `@google/model-viewer` is listed as a peer dependency.

### 8th Wall xrextras
The shutter button, flash overlay, and preview UI (`src/styles/capture-ui.css.ts`) were developed with reference to 8th Wall's [`xrextras`](https://github.com/8thwall/web/tree/master/xrextras) mediarecorder component (`record-button.css` / `media-preview.css`).
> xrextras — Copyright 2019 8th Wall, Inc. — [MIT License](https://github.com/8thwall/web/blob/master/xrextras/LICENSE)

### Build & Lint Configuration
The following configuration files are adapted from Google's [`google/model-viewer`](https://github.com/google/model-viewer):
| File | Source in upstream |
|---|---|
| `.clang-format` | `/.clang-format` — verbatim |
| `.eslintrc.yaml` | `/.eslintrc.yaml` — adapted |
| `.eslintignore` | `/.eslintignore` — adapted |
| `package.json` | `packages/model-viewer/package.json` + `/package.json` — adapted |
| `rollup.config.js` | `packages/model-viewer/rollup.config.js` — adapted |
| `tsconfig.json` | `packages/model-viewer/tsconfig.json` — adapted |
| `web-test-runner.config.mjs` | `packages/model-viewer/web-test-runner.config.mjs` — adapted |

> google/model-viewer — Copyright 2019 Google LLC — [Apache License 2.0](https://github.com/google/model-viewer/blob/master/LICENSE)

## License
MIT
