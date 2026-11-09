/* @license
 * Copyright 2026 k1pp0
 * SPDX-License-Identifier: MIT
 */

import { css } from 'lit';

// Layout/visuals developed with reference to 8thwall xrextras mediarecorder
// (record-button.css / media-preview.css). Theming is exposed via CSS
// custom properties on the host.
export const captureUIStyles = css`
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
