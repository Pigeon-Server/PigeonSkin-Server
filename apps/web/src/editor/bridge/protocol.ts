export type EditorKind = 'skin' | 'cape';
export type EditorTool = 'brush' | 'eraser' | 'fill' | 'picker' | 'select';
export type EditorView = '2d' | '3d' | 'split';

export type HostMessage =
  | { type: 'editor:init'; kind: EditorKind; model: 'default' | 'slim'; name: string; image: Blob | null; resourceId?: number; ownerId?: number | null; editable?: boolean }
  | { type: 'editor:command'; command: 'undo' | 'redo' | 'export' | 'createSkin' | 'createCape' | 'loadTexture' | 'loadSkin' | 'loadCape' | 'save'; image?: Blob | null; kind?: EditorKind };

export type FrameMessage =
  | { type: 'editor:ready' }
  | { type: 'editor:change'; dirty: boolean; model?: 'default' | 'slim' }
  | { type: 'editor:export'; image: Blob; width: number; height: number }
  | { type: 'editor:save'; image: Blob; width: number; height: number }
  | { type: 'editor:error'; message: string };

export function isFrameMessage(value: unknown): value is FrameMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const message = value as { type?: unknown; image?: unknown };
  if (message.type === 'editor:ready') return true;
  if (message.type === 'editor:change') return true;
  if (message.type === 'editor:error' && typeof (value as { message?: unknown }).message === 'string') return true;
  return (message.type === 'editor:export' || message.type === 'editor:save') && message.image instanceof Blob;
}
