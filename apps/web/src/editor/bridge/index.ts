export { isFrameMessage, type EditorKind, type EditorTool, type EditorView, type FrameMessage, type HostMessage } from './protocol';

export function createSkin(frame: HTMLIFrameElement, model: 'default' | 'slim' = 'default') {
  frame.contentWindow?.postMessage({ type: 'editor:command', command: 'createSkin', kind: 'skin', model }, location.origin);
}

export function createCape(frame: HTMLIFrameElement) {
  frame.contentWindow?.postMessage({ type: 'editor:command', command: 'createCape', kind: 'cape' }, location.origin);
}

export function loadTexture(frame: HTMLIFrameElement, image: Blob, kind: 'skin' | 'cape', model: 'default' | 'slim' = 'default') {
  frame.contentWindow?.postMessage({ type: 'editor:command', command: 'loadTexture', image, kind, model }, location.origin);
}

export const loadSkin = (frame: HTMLIFrameElement, image: Blob, model: 'default' | 'slim' = 'default') => loadTexture(frame, image, 'skin', model);
export const loadCape = (frame: HTMLIFrameElement, image: Blob) => loadTexture(frame, image, 'cape');

export function exportTexture(frame: HTMLIFrameElement) {
  frame.contentWindow?.postMessage({ type: 'editor:command', command: 'export' }, location.origin);
}

export function save(frame: HTMLIFrameElement) {
  frame.contentWindow?.postMessage({ type: 'editor:command', command: 'save' }, location.origin);
}

export function onChange(listener: (dirty: boolean) => void, message: MessageEvent) {
  if (message.origin !== location.origin || !message.data || message.data.type !== 'editor:change') return false;
  listener(Boolean(message.data.dirty));
  return true;
}

export function onSave(listener: (image: Blob) => void, message: MessageEvent) {
  if (message.origin !== location.origin || !message.data || message.data.type !== 'editor:save' || !(message.data.image instanceof Blob)) return false;
  listener(message.data.image);
  return true;
}
